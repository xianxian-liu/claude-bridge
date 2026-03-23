import Anthropic from "@anthropic-ai/sdk"
import { logger } from "./utils/logger.js"
import { generateSystemPrompt, getContextAwarePrompt } from "./system-prompt.js"
import { FeishuApiClient } from "./platforms/feishu/api.js"
import { DingTalkApiClient } from "./platforms/dingtalk/api.js"
import { parseFeishuDocUrl, parseFeishuFolderUrl, parseDingTalkDocUrl, detectDocPlatform } from "./utils/helpers.js"

export interface ClaudeClientConfig {
  apiKey: string
  model?: string
  maxTokens?: number
  systemPrompt?: string
  feishuApiClient?: FeishuApiClient
  dingtalkApiClient?: DingTalkApiClient
}

// Tool definitions for Claude API - document tools only
const TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: "fetch_doc",
    description:
      "根据文档链接获取文档内容。支持飞书文档和钉钉文档。" +
      "飞书文档支持 docx 和 wiki 类型，钉钉文档支持 alidocs.dingtalk.com 链接。" +
      "当用户发送文档链接时使用此工具读取文档内容。",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "文档链接，如 https://feishu.cn/docx/DoxdSxxxxxxxxxx 或 https://alidocs.dingtalk.com/i/nodes/xxxxxx",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "create_doc",
    description:
      "创建一个新的飞书云文档。可以在指定文件夹中创建，或创建在「我的文档」根目录。" +
      "创建成功后返回文档 ID 和链接。",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "文档标题",
        },
        folder_url: {
          type: "string",
          description: "目标文件夹链接（可选），如不提供则创建在「我的文档」根目录",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_doc",
    description:
      "向飞书文档追加文本内容。用于在创建文档后添加正文内容。" +
      "每次调用会在文档末尾追加新的文本块。",
    input_schema: {
      type: "object",
      properties: {
        doc_id: {
          type: "string",
          description: "文档 ID（由 create_doc 返回）",
        },
        content: {
          type: "string",
          description: "要追加的文本内容",
        },
      },
      required: ["doc_id", "content"],
    },
  },
]

/**
 * Claude API Client - Handles communication with Claude API with tool support
 */
export class ClaudeClient {
  private client: Anthropic
  private model: string
  private maxTokens: number
  private systemPrompt: string
  private feishuApiClient: FeishuApiClient | undefined
  private dingtalkApiClient: DingTalkApiClient | undefined
  private conversationHistory: Map<string, Anthropic.Messages.MessageParam[]> = new Map()

  constructor(config: ClaudeClientConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
    })
    this.model = config.model || "claude-sonnet-4-20250514"
    this.maxTokens = config.maxTokens || 4096

    // Use provided prompt or generate optimized one
    this.systemPrompt = config.systemPrompt || generateSystemPrompt()

    this.feishuApiClient = config.feishuApiClient
    this.dingtalkApiClient = config.dingtalkApiClient

    logger.info(`Claude client initialized with model: ${this.model}, tools: enabled`)
  }

  /**
   * Send a message to Claude and get a response
   */
  async sendMessage(
    userId: string,
    message: string,
    options?: {
      resetConversation?: boolean
      systemPrompt?: string
      enableTools?: boolean
    }
  ): Promise<string> {
    try {
      // Get or create conversation history for this user
      let history = this.conversationHistory.get(userId) || []

      // Reset conversation if requested
      if (options?.resetConversation) {
        history = []
        this.conversationHistory.set(userId, history)
      }

      // Add user message to history
      history.push({ role: "user", content: message })

      // Determine if tools should be used
      const enableTools = options?.enableTools !== false

      // Use custom system prompt, context-aware prompt, or default
      const systemPrompt = options?.systemPrompt || getContextAwarePrompt(message) || this.systemPrompt

      // Call Claude API
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        system: systemPrompt,
        messages: history,
        tools: enableTools ? TOOLS : undefined,
      })

      // Handle tool use if present
      let responseText = ""
      const toolUseBlocks: Anthropic.ToolUseBlock[] = []

      for (const block of response.content) {
        if (block.type === "text") {
          responseText += block.text
        } else if (block.type === "tool_use") {
          toolUseBlocks.push(block)
        }
      }

      // Process tool use blocks
      if (toolUseBlocks.length > 0) {
        // Add assistant message with tool use to history
        history.push({ role: "assistant", content: response.content })

        // Process each tool use
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []

        for (const toolUse of toolUseBlocks) {
          const result = await this.executeTool(toolUse)
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: result,
          })
        }

        // Add tool result to history
        history.push({
          role: "user",
          content: toolResults,
        })

        // Get final response after tool use
        const finalResponse = await this.client.messages.create({
          model: this.model,
          max_tokens: this.maxTokens,
          system: systemPrompt,
          messages: history,
        })

        responseText = this.extractText(finalResponse)

        // Add final assistant response to history
        history.push({ role: "assistant", content: responseText })
      } else {
        // Add assistant response to history
        history.push({ role: "assistant", content: responseText })
      }

      // Update conversation history (keep last 20 messages to avoid context overflow)
      if (history.length > 20) {
        history = history.slice(-20)
      }
      this.conversationHistory.set(userId, history)

      logger.info(`Claude response generated for user ${userId}, length: ${responseText.length}`)

      return responseText
    } catch (error) {
      logger.error(`Claude API error: ${error}`)
      throw error
    }
  }

  /**
   * Execute a tool call
   */
  private async executeTool(toolUse: Anthropic.ToolUseBlock): Promise<string> {
    logger.info(`Executing tool: ${toolUse.name}`)

    try {
      const args = toolUse.input as Record<string, any>

      switch (toolUse.name) {
        case "fetch_doc": {
          return await this.executeFetchDoc(args.url)
        }
        case "create_doc": {
          return await this.executeCreateDoc(args.title, args.folder_url)
        }
        case "update_doc": {
          return await this.executeUpdateDoc(args.doc_id, args.content)
        }
        default:
          return `Error: Unknown tool: ${toolUse.name}`
      }
    } catch (error: any) {
      logger.error(`Tool execution error: ${error.message}`)
      return `Error executing ${toolUse.name}: ${error.message}`
    }
  }

  /**
   * Execute fetch_doc tool
   */
  private async executeFetchDoc(url: string): Promise<string> {
    const platform = detectDocPlatform(url)

    if (platform === "dingtalk") {
      // Handle DingTalk document
      if (!this.dingtalkApiClient) {
        return "Error: DingTalk API client not configured. Document access requires DingTalk app credentials."
      }

      const docInfo = parseDingTalkDocUrl(url)
      if (!docInfo) {
        return `Error: Invalid DingTalk document URL. Expected format: https://alidocs.dingtalk.com/i/nodes/{docId}`
      }

      logger.info(`Fetching DingTalk document: ${docInfo.docId}`)

      const result = await this.dingtalkApiClient.fetchDocument(docInfo.docId)
      if (!result.success) {
        return `Error fetching DingTalk document: ${result.error}`
      }

      return `**文档标题**: ${result.title}\n\n**文档内容**:\n${result.content}`
    }

    if (platform === "feishu") {
      // Handle Feishu document
      if (!this.feishuApiClient) {
        return "Error: Feishu API client not configured. Document access requires Feishu app credentials."
      }

      const docInfo = parseFeishuDocUrl(url)
      if (!docInfo) {
        return `Error: Invalid Feishu document URL. Expected format: https://feishu.cn/docx/{docId} or https://feishu.cn/wiki/{docId}`
      }

      logger.info(`Fetching Feishu document: ${docInfo.docId} (type: ${docInfo.docType})`)

      const result = await this.feishuApiClient.fetchDocument(docInfo.docId)
      if (!result.success) {
        return `Error fetching Feishu document: ${result.error}`
      }

      return `**文档标题**: ${result.title}\n\n**文档内容**:\n${result.content}`
    }

    return `Error: Unsupported document URL. Supported platforms:
- Feishu: https://feishu.cn/docx/{docId} or https://feishu.cn/wiki/{docId}
- DingTalk: https://alidocs.dingtalk.com/i/nodes/{docId}`
  }

  /**
   * Execute create_doc tool
   */
  private async executeCreateDoc(title: string, folderUrl?: string): Promise<string> {
    if (!this.feishuApiClient) {
      return "Error: Feishu API client not configured. Document access requires Feishu app credentials."
    }

    let folderToken: string | undefined
    if (folderUrl) {
      const parsed = parseFeishuFolderUrl(folderUrl)
      if (!parsed) {
        return `Error: Invalid Feishu folder URL. Expected format: https://feishu.cn/drive/folder/{folderToken}`
      }
      folderToken = parsed
      logger.info(`Creating document in folder: ${folderToken}`)
    }

    const result = await this.feishuApiClient.createDocument(title, folderToken)
    if (!result.success) {
      return `Error creating document: ${result.error}`
    }

    return `文档创建成功！\n\n**文档 ID**: ${result.docId}\n**文档链接**: ${result.docUrl}`
  }

  /**
   * Execute update_doc tool
   */
  private async executeUpdateDoc(docId: string, content: string): Promise<string> {
    if (!this.feishuApiClient) {
      return "Error: Feishu API client not configured. Document access requires Feishu app credentials."
    }

    const result = await this.feishuApiClient.updateDocument(docId, content)
    if (!result.success) {
      return `Error updating document: ${result.error}`
    }

    return `文档更新成功！已追加内容到文档 ${docId}`
  }

  /**
   * Extract text content from Claude response
   */
  private extractText(response: Anthropic.Messages.Message): string {
    const textBlocks = response.content.filter(
      (block): block is Anthropic.TextBlock => block.type === "text"
    )
    return textBlocks.map((block) => block.text).join("\n")
  }

  /**
   * Clear conversation history for a user
   */
  clearConversation(userId: string): void {
    this.conversationHistory.delete(userId)
    logger.info(`Conversation cleared for user ${userId}`)
  }

  /**
   * Set the Feishu API client (called after platform adapters are initialized)
   */
  setFeishuApiClient(client: FeishuApiClient): void {
    this.feishuApiClient = client
    logger.info("Feishu API client configured for document access")
  }

  /**
   * Set the DingTalk API client (called after platform adapters are initialized)
   */
  setDingTalkApiClient(client: DingTalkApiClient): void {
    this.dingtalkApiClient = client
    logger.info("DingTalk API client configured for document access")
  }

  /**
   * Clear all conversation histories
   */
  clearAllConversations(): void {
    this.conversationHistory.clear()
    logger.info("All conversations cleared")
  }

  /**
   * Get conversation history for a user
   */
  getConversationHistory(userId: string): Anthropic.Messages.MessageParam[] {
    return this.conversationHistory.get(userId) || []
  }
}