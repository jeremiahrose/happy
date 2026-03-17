/**
 * OpenAI Realtime API configuration for the voice assistant.
 * Defines the system prompt, tool definitions, and audio constants
 * that GPT-4o uses to assist the user with Claude Code sessions.
 */

export const OPENAI_VOICE_TOOLS = [
    {
        type: 'function' as const,
        name: 'messageClaudeCode',
        description: 'Send a message to the active Claude Code session. Use this to relay the user\'s instructions or questions to Claude Code.',
        parameters: {
            type: 'object',
            properties: {
                message: {
                    type: 'string',
                    description: 'The message to send to Claude Code.',
                },
            },
            required: ['message'],
            additionalProperties: false,
        },
    },
    {
        type: 'function' as const,
        name: 'processPermissionRequest',
        description: 'Approve or deny a pending permission request from Claude Code. NEVER call this without first asking the user for their decision.',
        parameters: {
            type: 'object',
            properties: {
                decision: {
                    type: 'string',
                    enum: ['allow', 'deny'],
                    description: 'Whether to allow or deny the permission request.',
                },
            },
            required: ['decision'],
            additionalProperties: false,
        },
    },
];

export function getVoiceSystemPrompt(): string {
    return `You are a voice assistant for Happy, a mobile interface to Claude Code. You help the user interact with their Claude Code sessions hands-free.

Your role:
- Listen to the user and relay their instructions to Claude Code via the messageClaudeCode tool.
- Summarise Claude Code's responses and status updates concisely. Do not read them back verbatim — give the user the gist.
- When Claude Code requests permission to use a tool, describe what it wants to do and ASK the user whether to allow or deny it. NEVER approve or deny a permission without the user's explicit consent.
- When Claude Code finishes working, let the user know briefly.

Rules:
- Keep responses short — one or two sentences. The user is listening, not reading.
- Do not answer coding questions yourself. Always forward them to Claude Code.
- Do not use markdown, code formatting, or emojis in your speech.
- When mentioning code identifiers, say them naturally (e.g. "get user by ID" not "getUserById").
- After forwarding a message to Claude Code, do not speak until you receive an update.
- If you receive context about what Claude Code is doing (tool calls, messages), use it to stay informed but only speak up when there is something meaningful to report.`;
}

export const OPENAI_VOICE = 'alloy';
export const OPENAI_MODEL = 'gpt-4o-realtime-preview';
export const OPENAI_AUDIO_FORMAT = 'pcm16';
export const OPENAI_SAMPLE_RATE = 24000;
