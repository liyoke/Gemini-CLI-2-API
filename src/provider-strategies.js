import { MODEL_PROTOCOL_PREFIX } from "./common.js";
import { GeminiStrategy } from "./gemini/gemini-strategy.js";
import { OpenAIStrategy } from "./openai/openai-strategy.js";

/**
 * Strategy factory that returns the appropriate strategy instance based on the provider protocol.
 */
class ProviderStrategyFactory {
  static getStrategy(providerProtocol) {
    switch (providerProtocol) {
      case MODEL_PROTOCOL_PREFIX.GEMINI:
        return new GeminiStrategy();
      case MODEL_PROTOCOL_PREFIX.OPENAI:
        return new OpenAIStrategy();
      default:
        throw new Error(`Unsupported provider protocol: ${providerProtocol}`);
    }
  }
}

export { ProviderStrategyFactory };
