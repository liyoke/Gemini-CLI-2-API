import { OAuth2Client } from "google-auth-library";
import * as http from "http";
import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import * as readline from "readline";
import {
  API_ACTIONS,
  ensureRolesInContents,
  formatExpiryTime,
} from "../common.js";

// --- Constants ---
const AUTH_REDIRECT_PORT = 8085;
const CREDENTIALS_DIR = ".gemini";
const CREDENTIALS_FILE = "oauth_creds.json";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";
const OAUTH_CLIENT_ID =
  "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const OAUTH_CLIENT_SECRET = "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";

function toGeminiApiResponse(codeAssistResponse) {
  if (!codeAssistResponse) return null;
  const compliantResponse = { candidates: codeAssistResponse.candidates };
  if (codeAssistResponse.usageMetadata)
    compliantResponse.usageMetadata = codeAssistResponse.usageMetadata;
  if (codeAssistResponse.promptFeedback)
    compliantResponse.promptFeedback = codeAssistResponse.promptFeedback;
  if (codeAssistResponse.automaticFunctionCallingHistory)
    compliantResponse.automaticFunctionCallingHistory =
      codeAssistResponse.automaticFunctionCallingHistory;
  return compliantResponse;
}

export class GeminiApiService {
  constructor(config) {
    this.authClient = new OAuth2Client(OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET);

    // 如果配置了 Cloudflare Worker 代理，设置自定义 OAuth Token 端点
    const oauthTokenUrl = config.OAUTH_TOKEN_URL;
    if (oauthTokenUrl) {
      const customTokenEndpoint = `${oauthTokenUrl}/token`;
      // 只修改 oauth2TokenUrl，保留其他默认端点
      this.authClient.endpoints.oauth2TokenUrl = customTokenEndpoint;
      console.log(`[Gemini Auth] OAuth2Client configured with custom token endpoint: ${customTokenEndpoint}`);
    }

    this.availableModels = [];
    this.isInitialized = false;
    this.isRefreshing = false; // 防止并发刷新的标志

    this.config = config;
    this.host = config.HOST;
    this.oauthCredsBase64 = config.GEMINI_OAUTH_CREDS_BASE64;
    this.oauthCredsFilePath = config.GEMINI_OAUTH_CREDS_FILE_PATH;
    this.projectId = config.PROJECT_ID;
    this.geminiBaseUrl = config.GEMINI_BASE_URL || CODE_ASSIST_ENDPOINT;
    this.oauthTokenUrl = oauthTokenUrl; // Cloudflare Worker 代理 URL
  }

  async initialize() {
    if (this.isInitialized) return;
    console.log("[Gemini] Initializing Gemini API Service...");
    console.log(`[Gemini] Using base URL: ${this.geminiBaseUrl}`);
    await this.initializeAuth();
    if (!this.projectId) {
      this.projectId = await this.discoverProjectAndModels();
    } else {
      console.log(`[Gemini] Using provided Project ID: ${this.projectId}`);
      this.availableModels = ["gemini-2.5-pro", "gemini-2.5-flash"];
      console.log(
        `[Gemini] Using fixed models: [${this.availableModels.join(", ")}]`,
      );
    }
    if (this.projectId === "default") {
      throw new Error(
        "Error: 'default' is not a valid project ID. Please provide a valid Google Cloud Project ID using the --project-id argument.",
      );
    }
    this.isInitialized = true;
    console.log(
      `[Gemini] Initialization complete. Project ID: ${this.projectId}`,
    );
  }

  async initializeAuth(forceRefresh = false) {
    if (this.authClient.credentials.access_token && !forceRefresh) return;

    if (this.oauthCredsBase64) {
      try {
        const decoded = Buffer.from(this.oauthCredsBase64, "base64").toString(
          "utf8",
        );
        const credentials = JSON.parse(decoded);
        this.authClient.setCredentials(credentials);
        console.log(
          "[Gemini Auth] Authentication configured successfully from base64 string.",
        );
        return;
      } catch (error) {
        console.error(
          "[Gemini Auth] Failed to parse base64 OAuth credentials:",
          error,
        );
        throw new Error(`Failed to load OAuth credentials from base64 string.`);
      }
    }

    const credPath =
      this.oauthCredsFilePath ||
      path.join(os.homedir(), CREDENTIALS_DIR, CREDENTIALS_FILE);
    try {
      const data = await fs.readFile(credPath, "utf8");
      const credentials = JSON.parse(data);
      this.authClient.setCredentials(credentials);
      console.log(
        "[Gemini Auth] Authentication configured successfully from file.",
      );
      if (forceRefresh) {
        console.log("[Gemini Auth] Forcing token refresh...");
        const { credentials: newCredentials } =
          await this.authClient.refreshAccessToken();
        this.authClient.setCredentials(newCredentials);
        await fs.writeFile(credPath, JSON.stringify(newCredentials, null, 2));
        console.log("[Gemini Auth] Refreshed token saved.");
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        console.log(
          `[Gemini Auth] Credentials file '${credPath}' not found. Starting new authentication flow...`,
        );
        const newTokens = await this.getNewToken(credPath);
        this.authClient.setCredentials(newTokens);
        console.log("[Gemini Auth] New token obtained and loaded into memory.");
      } else {
        console.error(
          "[Gemini Auth] Failed to initialize authentication from file:",
          error,
        );
        throw new Error(`Failed to load OAuth credentials.`);
      }
    }
  }

  /**
   * 确保token有效，如果即将过期则主动刷新
   * @param {boolean} forceRefresh - 强制刷新token
   * @returns {Promise<void>}
   */
  async ensureValidToken(forceRefresh = false) {
    // 首先检查是否有有效的凭证
    if (!this.authClient.credentials.access_token && !forceRefresh) {
      // 如果没有access token，尝试初始化认证
      try {
        await this.initializeAuth(false);
        return;
      } catch (error) {
        console.error(
          "[Gemini Auth] Failed to initialize authentication:",
          error.message,
        );
        throw new Error(
          "No valid OAuth credentials available. Please authenticate first.",
        );
      }
    }

    const now = Date.now();
    const { expiry_date } = this.authClient.credentials;
    const fiveMinutes = 5 * 60 * 1000; // 5分钟提前刷新阈值

    // 检查是否需要刷新token
    const needsRefresh =
      forceRefresh ||
      !expiry_date ||
      now >= expiry_date - fiveMinutes ||
      now >= expiry_date; // token已过期

    if (!needsRefresh) {
      return;
    }

    // 如果正在刷新，等待刷新完成
    if (this.isRefreshing && !forceRefresh) {
      console.log("[Gemini Auth] Token refresh in progress, waiting...");
      return new Promise((resolve) => {
        const checkRefresh = () => {
          if (!this.isRefreshing) {
            resolve();
          } else {
            setTimeout(checkRefresh, 100);
          }
        };
        checkRefresh();
      });
    }

    // 执行token刷新
    this.isRefreshing = true;
    try {
      console.log("[Gemini Auth] Token needs refresh, initiating...");
      await this.initializeAuth(true);
      console.log("[Gemini Auth] Token refresh completed successfully");
    } catch (error) {
      console.error("[Gemini Auth] Token refresh failed:", error.message);
      // 如果刷新失败，检查是否是凭证文件问题
      if (error.message.includes("Failed to load OAuth credentials")) {
        throw new Error(
          "OAuth credentials not found or invalid. Please check your credential file.",
        );
      }
      throw error;
    } finally {
      this.isRefreshing = false;
    }
  }

  async getNewToken(credPath) {
    const redirectUri = `http://${this.host}:${AUTH_REDIRECT_PORT}`;
    this.authClient.redirectUri = redirectUri;
    return new Promise((resolve, reject) => {
      const authUrl = this.authClient.generateAuthUrl({
        access_type: "offline",
        scope: ["https://www.googleapis.com/auth/cloud-platform"],
      });
      console.log(
        "\n[Gemini Auth] Please open this URL in your browser to authenticate:",
      );
      console.log(authUrl, "\n");
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url, redirectUri);
          const code = url.searchParams.get("code");
          const errorParam = url.searchParams.get("error");
          if (code) {
            console.log(
              `[Gemini Auth] Received successful callback from Google: ${req.url}`,
            );
            console.log(`[Gemini Auth] Using credentials path: ${credPath}`);
            try {
              res.writeHead(200, { "Content-Type": "text/plain" });
              res.end(
                "Authentication successful! You can close this browser tab.",
              );
              server.close();
              console.log("[Gemini Auth] Server closed, getting tokens...");
              const { tokens } = await this.authClient.getToken(code);
              console.log(
                `[Gemini Auth] Got tokens: ${JSON.stringify(tokens, null, 2)}`,
              );
              await fs.mkdir(path.dirname(credPath), { recursive: true });
              console.log(
                `[Gemini Auth] Directory created, writing file to: ${credPath}`,
              );
              await fs.writeFile(credPath, JSON.stringify(tokens, null, 2));
              console.log(
                "[Gemini Auth] New token received and saved to file.",
              );
              resolve(tokens);
            } catch (error) {
              console.error(
                "[Gemini Auth] Error during token processing:",
                error,
              );
              if (server.listening) server.close();
              reject(error);
            }
          } else if (errorParam) {
            const errorMessage = `Authentication failed. Google returned an error: ${errorParam}.`;
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end(errorMessage);
            server.close();
            reject(new Error(errorMessage));
          } else {
            console.log(
              `[Gemini Auth] Ignoring irrelevant request: ${req.url}`,
            );
            res.writeHead(204);
            res.end();
          }
        } catch (e) {
          if (server.listening) server.close();
          reject(e);
        }
      });
      server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          const errorMessage = `[Gemini Auth] Port ${AUTH_REDIRECT_PORT} on ${this.host} is already in use.`;
          console.error(errorMessage);
          reject(new Error(errorMessage));
        } else {
          reject(err);
        }
      });
      server.listen(AUTH_REDIRECT_PORT, this.host);
    });
  }

  async discoverProjectAndModels() {
    if (this.projectId) {
      console.log(
        `[Gemini] Using pre-configured Project ID: ${this.projectId}`,
      );
      return this.projectId;
    }

    console.log("[Gemini] Discovering Project ID...");
    this.availableModels = ["gemini-2.5-pro", "gemini-2.5-flash"];
    console.log(
      `[Gemini] Using fixed models: [${this.availableModels.join(", ")}]`,
    );
    try {
      const loadResponse = await this.callApi("loadCodeAssist", {
        metadata: { pluginType: "GEMINI" },
      });
      if (loadResponse.cloudaicompanionProject) {
        return loadResponse.cloudaicompanionProject;
      }
      const defaultTier = loadResponse.allowedTiers?.find(
        (tier) => tier.isDefault,
      );
      const onboardRequest = {
        tierId: defaultTier?.id || "free-tier",
        metadata: { pluginType: "GEMINI" },
        cloudaicompanionProject: "default",
      };
      let lro = await this.callApi("onboardUser", onboardRequest);
      while (!lro.done) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        lro = await this.callApi("onboardUser", onboardRequest);
      }
      return lro.response?.cloudaicompanionProject?.id;
    } catch (error) {
      console.error(
        "[Gemini] Failed to discover Project ID:",
        error.response?.data || error.message,
      );
      throw new Error("Could not discover a valid Google Cloud Project ID.");
    }
  }

  async listModels() {
    if (!this.isInitialized) await this.initialize();
    const formattedModels = this.availableModels.map((modelId) => {
      const displayName = modelId
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ");
      return {
        name: `models/${modelId}`,
        version: "1.0.0",
        displayName: displayName,
        description: `A generative model for text and chat generation. ID: ${modelId}`,
        inputTokenLimit: 32768,
        outputTokenLimit: 8192,
        supportedGenerationMethods: [
          "generateContent",
          "streamGenerateContent",
        ],
      };
    });
    return { models: formattedModels };
  }

  async callApi(method, body, isRetry = false, retryCount = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES;
    const baseDelay = this.config.REQUEST_BASE_DELAY; // 1 second base delay

    try {
      const requestOptions = {
        url: `${this.geminiBaseUrl}/${CODE_ASSIST_API_VERSION}:${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        responseType: "json",
        body: JSON.stringify(body),
        timeout: 30000, // 30 second timeout
      };
      const res = await this.authClient.request(requestOptions);
      return res.data;
    } catch (error) {
      // Handle network timeout errors specifically
      if (
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNRESET" ||
        error.code === "ENOTFOUND"
      ) {
        if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          console.log(
            `[API] Network error (${error.code}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          return this.callApi(method, body, isRetry, retryCount + 1);
        }
        throw new Error(
          `Network error: Unable to connect to Google services after ${maxRetries} attempts. Please check your internet connection.`,
        );
      }

      if (error.response?.status === 401 && !isRetry) {
        console.log("[API] Received 401. Refreshing auth and retrying...");
        try {
          await this.initializeAuth(true);
          return this.callApi(method, body, true, retryCount);
        } catch (authError) {
          // If auth refresh fails due to network issues, handle it gracefully
          if (
            authError.code === "ETIMEDOUT" ||
            authError.code === "ECONNRESET" ||
            authError.code === "ENOTFOUND"
          ) {
            throw new Error(
              `Authentication failed: Unable to connect to Google OAuth services. Please check your internet connection and try again.`,
            );
          }
          throw authError;
        }
      }

      // Handle 429 (Too Many Requests) with exponential backoff
      if (error.response?.status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        console.log(
          `[API] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.callApi(method, body, isRetry, retryCount + 1);
      }

      // Handle other retryable errors (5xx server errors)
      if (
        error.response?.status >= 500 &&
        error.response?.status < 600 &&
        retryCount < maxRetries
      ) {
        const delay = baseDelay * Math.pow(2, retryCount);
        console.log(
          `[API] Received ${error.response.status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.callApi(method, body, isRetry, retryCount + 1);
      }

      throw error;
    }
  }

  async *streamApi(method, body, isRetry = false, retryCount = 0) {
    const maxRetries = this.config.REQUEST_MAX_RETRIES;
    const baseDelay = this.config.REQUEST_BASE_DELAY; // 1 second base delay

    try {
      const requestOptions = {
        url: `${this.geminiBaseUrl}/${CODE_ASSIST_API_VERSION}:${method}`,
        method: "POST",
        params: { alt: "sse" },
        headers: { "Content-Type": "application/json" },
        responseType: "stream",
        body: JSON.stringify(body),
        timeout: 30000, // 30 second timeout
      };
      const res = await this.authClient.request(requestOptions);
      if (res.status !== 200) {
        let errorBody = "";
        for await (const chunk of res.data) errorBody += chunk.toString();
        throw new Error(
          `Upstream API Error (Status ${res.status}): ${errorBody}`,
        );
      }
      yield* this.parseSSEStream(res.data);
    } catch (error) {
      // Handle network timeout errors specifically
      if (
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNRESET" ||
        error.code === "ENOTFOUND"
      ) {
        if (retryCount < maxRetries) {
          const delay = baseDelay * Math.pow(2, retryCount);
          console.log(
            `[API] Network error during stream (${error.code}). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          yield* this.streamApi(method, body, isRetry, retryCount + 1);
          return;
        }
        throw new Error(
          `Network error: Unable to connect to Google services after ${maxRetries} attempts. Please check your internet connection.`,
        );
      }

      if (error.response?.status === 401 && !isRetry) {
        console.log(
          "[API] Received 401 during stream. Refreshing auth and retrying...",
        );
        try {
          await this.initializeAuth(true);
          yield* this.streamApi(method, body, true, retryCount);
          return;
        } catch (authError) {
          // If auth refresh fails due to network issues, handle it gracefully
          if (
            authError.code === "ETIMEDOUT" ||
            authError.code === "ECONNRESET" ||
            authError.code === "ENOTFOUND"
          ) {
            throw new Error(
              `Authentication failed: Unable to connect to Google OAuth services. Please check your internet connection and try again.`,
            );
          }
          throw authError;
        }
      }

      // Handle 429 (Too Many Requests) with exponential backoff
      if (error.response?.status === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount);
        console.log(
          `[API] Received 429 (Too Many Requests) during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        yield* this.streamApi(method, body, isRetry, retryCount + 1);
        return;
      }

      // Handle other retryable errors (5xx server errors)
      if (
        error.response?.status >= 500 &&
        error.response?.status < 600 &&
        retryCount < maxRetries
      ) {
        const delay = baseDelay * Math.pow(2, retryCount);
        console.log(
          `[API] Received ${error.response.status} server error during stream. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        yield* this.streamApi(method, body, isRetry, retryCount + 1);
        return;
      }

      throw error;
    }
  }

  async *parseSSEStream(stream) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let buffer = [];
    for await (const line of rl) {
      if (line.startsWith("data: ")) buffer.push(line.slice(6));
      else if (line === "" && buffer.length > 0) {
        try {
          yield JSON.parse(buffer.join("\n"));
        } catch (e) {
          console.error(
            "[Stream] Failed to parse JSON chunk:",
            buffer.join("\n"),
          );
        }
        buffer = [];
      }
    }
    if (buffer.length > 0) {
      try {
        yield JSON.parse(buffer.join("\n"));
      } catch (e) {
        console.error(
          "[Stream] Failed to parse final JSON chunk:",
          buffer.join("\n"),
        );
      }
    }
  }

  async generateContent(model, requestBody) {
    console.log(
      `[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`,
    );

    // 主动检查并刷新token
    await this.ensureValidToken();

    const processedRequestBody = ensureRolesInContents(requestBody);
    const apiRequest = {
      model,
      project: this.projectId,
      request: processedRequestBody,
    };
    const response = await this.callApi(
      API_ACTIONS.GENERATE_CONTENT,
      apiRequest,
    );
    return toGeminiApiResponse(response.response);
  }

  async *generateContentStream(model, requestBody) {
    console.log(
      `[Auth Token] Time until expiry: ${formatExpiryTime(this.authClient.credentials.expiry_date)}`,
    );

    // 主动检查并刷新token
    await this.ensureValidToken();

    const processedRequestBody = ensureRolesInContents(requestBody);
    const apiRequest = {
      model,
      project: this.projectId,
      request: processedRequestBody,
    };
    const stream = this.streamApi(
      API_ACTIONS.STREAM_GENERATE_CONTENT,
      apiRequest,
    );
    for await (const chunk of stream) {
      yield toGeminiApiResponse(chunk.response);
    }
  }
}
