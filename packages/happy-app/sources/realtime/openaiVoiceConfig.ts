/**
 * OpenAI Realtime API configuration for the voice assistant.
 * Defines the system prompt and tool definitions that GPT-4o uses
 * to relay voice commands to Claude Code sessions.
 */

export const OPENAI_VOICE_TOOLS = [
    {
        type: 'function' as const,
        name: 'messageClaudeCode',
        description: 'Send the user\'s spoken command or message to the active Claude Code session',
        parameters: {
            type: 'object',
            properties: {
                message: {
                    type: 'string',
                    description: 'The transcribed user message to send to Claude Code',
                },
            },
            required: ['message'],
            additionalProperties: false,
        },
    },
    {
        type: 'function' as const,
        name: 'processPermissionRequest',
        description: 'Approve or deny a pending permission request from Claude Code. Use when the user says something like "allow", "approve", "yes", "deny", "no", "reject".',
        parameters: {
            type: 'object',
            properties: {
                decision: {
                    type: 'string',
                    enum: ['allow', 'deny'],
                    description: 'Whether to allow or deny the permission request',
                },
            },
            required: ['decision'],
            additionalProperties: false,
        },
    },
];

export function getVoiceSystemPrompt(): string {
    return `You are a voice relay for Happy, a mobile interface to Claude Code. Your ONLY job is to forward the user's speech to Claude Code via the messageClaudeCode tool and to relay status updates back.

You are NOT an assistant. You do NOT answer questions. You do NOT have opinions. You are a microphone and a speaker.

Your workflow:
1. Listen to the user's speech.
2. Call the messageClaudeCode tool with what they said. ALWAYS do this for any user utterance that is not a permission decision.
3. When you receive contextual updates about what Claude Code is doing, summarize them briefly for the user.
4. When Claude Code finishes work, tell the user.

For permission requests:
- When Claude Code requests permission to use a tool, describe what it wants to do.
- If the user says "allow", "yes", "approve" etc, call processPermissionRequest with decision "allow".
- If the user says "deny", "no", "reject" etc, call processPermissionRequest with decision "deny".

CRITICAL RULES:
- NEVER answer questions about code, programming, files, or anything else yourself. ALWAYS forward to Claude Code via the messageClaudeCode tool.
- Even if you have context about the code from status updates, do NOT use it to answer questions. Forward the question to Claude Code.
- Keep your spoken responses SHORT - one sentence maximum.
- Never volunteer information or make suggestions.
- Do not use markdown or formatting in speech.
- Do not use emojis.
- When reading code identifiers aloud, spell them out naturally (e.g. "get user by ID" not "getUserById").
- Always transcribe into English regardless of what language the user speaks.`;
}

export const OPENAI_VOICE = 'alloy';
export const OPENAI_MODEL = 'gpt-4o-realtime-preview';
export const OPENAI_AUDIO_FORMAT = 'pcm16';
export const OPENAI_SAMPLE_RATE = 24000;
