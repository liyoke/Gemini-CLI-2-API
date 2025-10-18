import { v4 as uuidv4 } from "uuid";
import {
  MODEL_PROVIDER,
  MODEL_PROTOCOL_PREFIX,
  getProtocolPrefix,
} from "./common.js";

/**
 * Generic data conversion function.
 * @param {object} data - The data to convert (request body or response).
 * @param {string} type - The type of conversion: 'request', 'response', 'streamChunk', 'modelList'.
 * @param {string} fromProvider - The source model provider (e.g., MODEL_PROVIDER.GEMINI_CLI).
 * @param {string} toProvider - The target model provider (e.g., MODEL_PROVIDER.OPENAI_CUSTOM).
 * @param {string} [model] - Optional model name for response conversions.
 * @returns {object} The converted data.
 * @throws {Error} If no suitable conversion function is found.
 */
export function convertData(data, type, fromProvider, toProvider, model) {
  // Define a map of conversion functions using protocol prefixes
  const conversionMap = {
    request: {
      [MODEL_PROTOCOL_PREFIX.OPENAI]: {
        // to OpenAI protocol
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIRequestFromGemini, // from Gemini protocol
      },
      [MODEL_PROTOCOL_PREFIX.GEMINI]: {
        // to Gemini protocol
        [MODEL_PROTOCOL_PREFIX.OPENAI]: toGeminiRequestFromOpenAI, // from OpenAI protocol
      },
    },
    response: {
      [MODEL_PROTOCOL_PREFIX.OPENAI]: {
        // to OpenAI protocol
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIChatCompletionFromGemini, // from Gemini protocol
      },
    },
    streamChunk: {
      [MODEL_PROTOCOL_PREFIX.OPENAI]: {
        // to OpenAI protocol
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIStreamChunkFromGemini, // from Gemini protocol
      },
    },
    modelList: {
      [MODEL_PROTOCOL_PREFIX.OPENAI]: {
        // to OpenAI protocol
        [MODEL_PROTOCOL_PREFIX.GEMINI]: toOpenAIModelListFromGemini, // from Gemini protocol
      },
    },
  };

  const targetConversions = conversionMap[type];
  if (!targetConversions) {
    throw new Error(`Unsupported conversion type: ${type}`);
  }

  const toConversions = targetConversions[getProtocolPrefix(toProvider)];
  if (!toConversions) {
    throw new Error(
      `No conversions defined for target protocol: ${getProtocolPrefix(toProvider)} for type: ${type}`,
    );
  }

  const conversionFunction = toConversions[getProtocolPrefix(fromProvider)];
  if (!conversionFunction) {
    throw new Error(
      `No conversion function found from ${fromProvider} to ${toProvider} for type: ${type}`,
    );
  }

  console.log(conversionFunction);
  if (type === "response" || type === "streamChunk" || type === "modelList") {
    return conversionFunction(data, model);
  } else {
    return conversionFunction(data);
  }
}

/**
 * Converts a Gemini API request body to an OpenAI chat completion request body.
 * Handles system instructions and role mapping.
 * @param {Object} geminiRequest - The request body from the Gemini API.
 * @returns {Object} The formatted request body for the OpenAI API.
 */
export function toOpenAIRequestFromGemini(geminiRequest) {
  const openaiRequest = {
    messages: [],
    model: geminiRequest.model || "gpt-3.5-turbo", // Default model if not specified in Gemini request
  };

  // Process system instruction
  if (
    geminiRequest.systemInstruction &&
    Array.isArray(geminiRequest.systemInstruction.parts)
  ) {
    const systemText = geminiRequest.systemInstruction.parts
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");
    if (systemText) {
      openaiRequest.messages.push({
        role: "system",
        content: systemText,
      });
    }
  }

  // Process contents
  if (geminiRequest.contents && Array.isArray(geminiRequest.contents)) {
    geminiRequest.contents.forEach((content) => {
      if (content && Array.isArray(content.parts)) {
        const contentText = content.parts
          .filter((part) => part && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        if (contentText) {
          const openaiRole =
            content.role === "model" ? "assistant" : content.role;
          openaiRequest.messages.push({
            role: openaiRole,
            content: contentText,
          });
        }
      }
    });
  }

  return openaiRequest;
}

export function toOpenAIModelListFromGemini(geminiModels) {
  return {
    object: "list",
    data: geminiModels.models.map((m) => ({
      id: m.name.startsWith("models/") ? m.name.substring(7) : m.name, // 移除 'models/' 前缀作为 id
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "google",
    })),
  };
}

export function toOpenAIChatCompletionFromGemini(geminiResponse, model) {
  return {
    id: `chatcmpl-${uuidv4()}`, // uuidv4 needs to be imported or handled
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: geminiResponse.candidates
            .map((candidate) =>
              candidate.content.parts.map((part) => part.text).join(""),
            )
            .join("\n"), // Use '\n' to separate content from different candidates if needed
        },
        finish_reason: "stop",
      },
    ],
    usage: geminiResponse.usageMetadata
      ? {
          prompt_tokens: geminiResponse.usageMetadata.promptTokenCount || 0,
          completion_tokens:
            geminiResponse.usageMetadata.candidatesTokenCount || 0,
          total_tokens: geminiResponse.usageMetadata.totalTokenCount || 0,
        }
      : {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
  };
}

export function toOpenAIStreamChunkFromGemini(geminiChunk, model) {
  return {
    id: `chatcmpl-${uuidv4()}`, // uuidv4 needs to be imported or handled
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model,
    choices: [
      {
        index: 0,
        delta: { content: geminiChunk },
        finish_reason: null,
      },
    ],
    usage: geminiChunk.usageMetadata
      ? {
          prompt_tokens: geminiChunk.usageMetadata.promptTokenCount || 0,
          completion_tokens:
            geminiChunk.usageMetadata.candidatesTokenCount || 0,
          total_tokens: geminiChunk.usageMetadata.totalTokenCount || 0,
        }
      : {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
  };
}

/**
 * Converts an OpenAI chat completion request body to a Gemini API request body.
 * Handles system instructions and merges consecutive messages of the same role.
 * @param {Object} openaiRequest - The request body from the OpenAI API.
 * @returns {Object} The formatted request body for the Gemini API.
 */
export function toGeminiRequestFromOpenAI(openaiRequest) {
  const geminiRequest = {
    contents: [],
  };

  const messages = openaiRequest.messages || [];

  // 1. Extract and process system messages
  const { systemInstruction, nonSystemMessages } =
    extractAndProcessSystemMessages(messages);
  if (systemInstruction) {
    geminiRequest.systemInstruction = systemInstruction;
  }

  // 2. Process non-system messages, merging consecutive messages of the same role.
  if (nonSystemMessages.length > 0) {
    const mergedContents = nonSystemMessages.reduce((acc, message) => {
      // Map OpenAI 'assistant' role to Gemini 'model' role
      const geminiRole = message.role === "assistant" ? "model" : message.role;

      // Ignore roles that are not 'user' or 'model' (e.g., 'tool' messages)
      if (geminiRole !== "user" && geminiRole !== "model") {
        return acc;
      }

      const messageText = extractTextFromMessageContent(message.content);

      if (acc.length > 0 && acc[acc.length - 1].role === geminiRole) {
        // If the last content block has the same role, append to its text
        acc[acc.length - 1].parts[0].text += "\n" + messageText;
      } else {
        // Otherwise, start a new content block for the new role
        acc.push({
          role: geminiRole,
          parts: [{ text: messageText }],
        });
      }
      return acc;
    }, []);
    geminiRequest.contents = mergedContents;
  }

  // 3. Basic validation and logging (the Gemini API will perform final validation)
  // Log warnings if the conversation does not start or end with a 'user' role,
  // as this is often required by Gemini for multi-turn conversations.
  if (geminiRequest.contents.length > 0) {
    if (geminiRequest.contents[0].role !== "user") {
      console.warn(
        "[Request Conversion] Warning: Conversation doesn't start with a 'user' role. The API may reject this request.",
      );
    }
    if (
      geminiRequest.contents[geminiRequest.contents.length - 1].role !== "user"
    ) {
      console.warn(
        "[Request Conversion] Warning: The last message in the conversation is not from the 'user'. The API may reject this request.",
      );
    }
  }

  return geminiRequest;
}

/**
 * Extracts and combines all 'system' role messages into a single system instruction.
 * Filters out system messages and returns the remaining non-system messages.
 * @param {Array<Object>} messages - Array of message objects from OpenAI request.
 * @returns {{systemInstruction: Object|null, nonSystemMessages: Array<Object>}}
 *          An object containing the system instruction and an array of non-system messages.
 */
export function extractAndProcessSystemMessages(messages) {
  const systemContents = [];
  const nonSystemMessages = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemContents.push(extractTextFromMessageContent(message.content));
    } else {
      nonSystemMessages.push(message);
    }
  }

  let systemInstruction = null;
  if (systemContents.length > 0) {
    systemInstruction = {
      parts: [
        {
          text: systemContents.join("\n"),
        },
      ],
    };
  }
  return { systemInstruction, nonSystemMessages };
}

/**
 * Extracts text from various forms of message content.
 * @param {string|Array<Object>} content - The content from a message object.
 * @returns {string} The extracted text.
 */
export function extractTextFromMessageContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}
