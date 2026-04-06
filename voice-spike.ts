#!/usr/bin/env npx tsx
/**
 * Voice Spike — CLI tool to test realtime voice APIs with different models.
 *
 * Supports:
 *   - OpenAI Realtime API (WebSocket)
 *   - Google Gemini Live API (WebSocket)
 *
 * Usage:
 *   npx tsx voice-spike.ts <provider:model> [--push-to-talk]
 *
 * Examples:
 *   npx tsx voice-spike.ts openai:gpt-realtime-mini
 *   npx tsx voice-spike.ts openai:gpt-realtime-1.5
 *   npx tsx voice-spike.ts gemini:gemini-2.0-flash-live-001
 *   npx tsx voice-spike.ts gemini:gemini-2.5-flash-native-audio-preview
 *
 * Environment:
 *   OPENAI_API_KEY   — for OpenAI models
 *   GEMINI_API_KEY   — for Gemini models
 *
 * CLI commands while running:
 *   Type text + Enter  → inject a mock [CLAUDE] response into the session
 *   /tool <name> <json> → inject a mock tool use notification
 *   /perm <id> <tool>   → inject a mock permission request
 *   /ready              → inject a mock ready event
 *   /quit               → exit
 */

import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// System prompt (matches app)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a STT/TTS translation layer between a human user and Claude Code. You are NOT an assistant. You do not think, reason, or answer questions.

INPUTS YOU RECEIVE:
1. User speech (audio) — the human talking to you.
2. Text messages — these come from TWO sources, distinguished by prefix:
   - [CLAUDE] — context updates from Claude Code. These are NOT the user speaking.
   - [USER] — historical user messages (for context only).
   - No prefix — treat as user input.

HANDLING USER SPEECH (audio):
- Transcribe and forward verbatim to Claude Code via messageClaudeCode. Do not interpret, rephrase, summarize, or answer.
- EXCEPTION: If the user says "yes", "approve", "allow", "go ahead", "deny", "no", or "reject" while a permission request is pending, call processPermissionRequest instead.
- Ignore unclear, garbled, or ambient noise. Only act on clear speech.

HANDLING [CLAUDE] MESSAGES:
- "Permission request": Verbally describe the tool and arguments to the user, then wait for their approve/deny.
- "Tool use": Briefly mention what tool Claude is using.
- "Response" (2 sentences or fewer): Read verbatim to the user.
- "Response" (longer): Summarize concisely for the user.
- "Ready": Tell the user Claude is done and briefly mention what was accomplished.
- "Status": Briefly inform the user (e.g. "Claude's session came online").

STRICT RULES:
- NEVER answer any question yourself. You have no knowledge.
- NEVER add commentary, opinions, or filler. Just relay.
- Speak naturally — no markdown, no code formatting, no emojis.
- Say code identifiers naturally (e.g. "get user by ID" not "getUserById").
- After forwarding to Claude, stay silent until you receive a [CLAUDE] update.`;

// ---------------------------------------------------------------------------
// Tool definitions (same as app)
// ---------------------------------------------------------------------------

const TOOLS_OPENAI = [
    {
        type: 'function' as const,
        name: 'messageClaudeCode',
        description: 'Send a message to the active Claude Code session. Use this to relay the user\'s instructions or questions to Claude Code.',
        parameters: {
            type: 'object',
            properties: {
                message: { type: 'string', description: 'The message to send to Claude Code.' },
            },
            required: ['message'],
            additionalProperties: false,
        },
    },
    {
        type: 'function' as const,
        name: 'processPermissionRequest',
        description: 'Approve or deny a pending permission request from Claude Code. NEVER call this without first asking the user for their decision. Always pass the request_id from the permission notification.',
        parameters: {
            type: 'object',
            properties: {
                decision: { type: 'string', enum: ['allow', 'deny'], description: 'Whether to allow or deny the permission request.' },
                requestId: { type: 'string', description: 'The request_id from the permission request notification.' },
            },
            required: ['decision', 'requestId'],
            additionalProperties: false,
        },
    },
];

const TOOLS_GEMINI = [
    {
        functionDeclarations: [
            {
                name: 'messageClaudeCode',
                description: 'Send a message to the active Claude Code session. Use this to relay the user\'s instructions or questions to Claude Code.',
                parameters: {
                    type: 'object',
                    properties: {
                        message: { type: 'string', description: 'The message to send to Claude Code.' },
                    },
                    required: ['message'],
                },
            },
            {
                name: 'processPermissionRequest',
                description: 'Approve or deny a pending permission request from Claude Code. NEVER call this without first asking the user for their decision. Always pass the request_id from the permission notification.',
                parameters: {
                    type: 'object',
                    properties: {
                        decision: { type: 'string', enum: ['allow', 'deny'], description: 'Whether to allow or deny the permission request.' },
                        requestId: { type: 'string', description: 'The request_id from the permission request notification.' },
                    },
                    required: ['decision', 'requestId'],
                },
            },
        ],
    },
];

// ---------------------------------------------------------------------------
// Audio config
// ---------------------------------------------------------------------------

const OPENAI_SAMPLE_RATE = 24000;
const GEMINI_SAMPLE_RATE = 16000;

// ---------------------------------------------------------------------------
// Mic recording via sox/rec
// ---------------------------------------------------------------------------

function startMicRecording(sampleRate: number, onData: (base64: string) => void): ChildProcess {
    // rec outputs raw PCM 16-bit signed LE mono
    const proc = spawn('rec', [
        '-q',                    // quiet
        '-r', String(sampleRate),
        '-e', 'signed-integer',
        '-b', '16',
        '-c', '1',
        '-t', 'raw',
        '-',                     // stdout
    ]);

    proc.stdout.on('data', (chunk: Buffer) => {
        onData(chunk.toString('base64'));
    });

    proc.stderr.on('data', () => {}); // ignore sox info
    proc.on('error', () => {}); // ignore spawn errors

    return proc;
}

// ---------------------------------------------------------------------------
// Audio playback via sox/play
// ---------------------------------------------------------------------------

let playProc: ChildProcess | null = null;

function ensurePlayProcess(sampleRate: number): ChildProcess {
    if (playProc && !playProc.killed) return playProc;
    playProc = spawn('play', [
        '-q',
        '-r', String(sampleRate),
        '-e', 'signed-integer',
        '-b', '16',
        '-c', '1',
        '-t', 'raw',
        '-',
    ]);
    playProc.stdin?.on('error', () => {}); // ignore EPIPE
    playProc.on('exit', () => { playProc = null; });
    return playProc;
}

function playAudio(base64: string, sampleRate: number) {
    try {
        const proc = ensurePlayProcess(sampleRate);
        if (proc.stdin && !proc.stdin.destroyed) {
            proc.stdin.write(Buffer.from(base64, 'base64'));
        }
    } catch {
        // play process died, will respawn on next call
        playProc = null;
    }
}

function stopPlayback() {
    if (playProc && !playProc.killed) {
        playProc.kill();
        playProc = null;
    }
}

// ---------------------------------------------------------------------------
// OpenAI Realtime provider
// ---------------------------------------------------------------------------

async function connectOpenAI(model: string, pushToTalk: boolean): Promise<{
    ws: WebSocket;
    injectContext: (text: string) => void;
    injectTextAndRespond: (text: string) => void;
    cleanup: () => void;
}> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY not set');

    console.log(`[OpenAI] Getting ephemeral token for ${model}...`);

    const tokenRes = await fetch('https://api.openai.com/v1/realtime/sessions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, voice: 'alloy' }),
    });
    if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`Failed to get ephemeral token: ${tokenRes.status} ${err}`);
    }
    const tokenData = await tokenRes.json() as any;
    const ephemeralKey = tokenData.client_secret?.value;
    if (!ephemeralKey) throw new Error('No ephemeral key in response');

    console.log(`[OpenAI] Connecting WebSocket...`);

    const url = `wss://api.openai.com/v1/realtime?model=${model}`;
    const ws = new WebSocket(url, [
        'realtime',
        `openai-insecure-api-key.${ephemeralKey}`,
        'openai-beta.realtime-v1',
    ]);

    let micProc: ChildProcess | null = null;
    let isResponseActive = false;
    const pendingQueue: (() => void)[] = [];

    function send(msg: any) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    function createResponseOrQueue(fn: () => void) {
        if (isResponseActive) {
            pendingQueue.push(fn);
        } else {
            fn();
        }
    }

    function onResponseStarted() {
        isResponseActive = true;
    }

    function onResponseDone() {
        isResponseActive = false;
        if (pendingQueue.length > 0) {
            const next = pendingQueue.shift()!;
            next();
        }
    }

    ws.on('open', () => {
        console.log('[OpenAI] WebSocket connected, waiting for session.created...');
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
            case 'session.created':
                console.log('[OpenAI] Session created, configuring...');
                send({
                    type: 'session.update',
                    session: {
                        voice: 'alloy',
                        modalities: ['text', 'audio'],
                        input_audio_format: 'pcm16',
                        output_audio_format: 'pcm16',
                        turn_detection: pushToTalk ? null : {
                            type: 'server_vad',
                            threshold: 0.7,
                            prefix_padding_ms: 300,
                            silence_duration_ms: 700,
                        },
                        tools: TOOLS_OPENAI,
                        instructions: SYSTEM_PROMPT,
                        speed: 1.3,
                    },
                });
                break;

            case 'session.updated':
                console.log('[OpenAI] Session configured. Listening...');
                if (!pushToTalk) {
                    micProc = startMicRecording(OPENAI_SAMPLE_RATE, (b64) => {
                        send({ type: 'input_audio_buffer.append', audio: b64 });
                    });
                }
                break;

            case 'response.audio.delta':
                if (msg.delta) playAudio(msg.delta, OPENAI_SAMPLE_RATE);
                break;

            case 'response.audio_transcript.delta':
                process.stdout.write(msg.delta || '');
                break;

            case 'response.audio_transcript.done':
                console.log(); // newline after transcript
                break;

            case 'response.created':
                onResponseStarted();
                break;

            case 'response.done':
                if (msg.response?.output) {
                    for (const item of msg.response.output) {
                        if (item.type === 'function_call' && item.call_id) {
                            handleToolCall('openai', item.name, item.arguments, item.call_id, send, createResponseOrQueue, onResponseStarted);
                        }
                    }
                }
                onResponseDone();
                break;

            case 'input_audio_buffer.speech_started':
                console.log('\n[Mic] Speech detected');
                stopPlayback();
                break;

            case 'input_audio_buffer.speech_stopped':
                console.log('[Mic] Speech ended');
                break;

            case 'error':
                console.error('[OpenAI] Error:', JSON.stringify(msg.error));
                break;

            default:
                // Ignore other event types
                break;
        }
    });

    ws.on('error', (err) => console.error('[OpenAI] WS error:', err.message));
    ws.on('close', (code, reason) => {
        console.log(`[OpenAI] WS closed: ${code} ${reason}`);
        if (micProc && !micProc.killed) micProc.kill();
        stopPlayback();
    });

    // Wait for session.updated
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
        const origHandler = ws.listeners('message')[0] as any;
        ws.on('message', function waitForReady(data) {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'session.updated') {
                clearTimeout(timeout);
                ws.removeListener('message', waitForReady);
                resolve();
            }
        });
    });

    return {
        ws,
        injectContext(text: string) {
            send({
                type: 'conversation.item.create',
                item: { type: 'message', role: 'system', content: [{ type: 'input_text', text }] },
            });
        },
        injectTextAndRespond(text: string) {
            createResponseOrQueue(() => {
                send({
                    type: 'conversation.item.create',
                    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
                });
                onResponseStarted();
                send({ type: 'response.create', response: { tool_choice: 'none' } });
            });
        },
        cleanup() {
            if (micProc && !micProc.killed) micProc.kill();
            stopPlayback();
            if (ws.readyState === WebSocket.OPEN) ws.close();
        },
    };
}

// ---------------------------------------------------------------------------
// Gemini Live provider
// ---------------------------------------------------------------------------

async function connectGemini(model: string, pushToTalk: boolean): Promise<{
    ws: WebSocket;
    injectContext: (text: string) => void;
    injectTextAndRespond: (text: string) => void;
    cleanup: () => void;
}> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const modelPath = model.startsWith('models/') ? model : `models/${model}`;
    const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;

    console.log(`[Gemini] Connecting WebSocket for ${modelPath}...`);
    const ws = new WebSocket(url);

    let micProc: ChildProcess | null = null;

    function send(msg: any) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        }
    }

    ws.on('open', () => {
        console.log('[Gemini] WebSocket connected, sending setup...');
        send({
            setup: {
                model: modelPath,
                generationConfig: {
                    responseModalities: ['AUDIO', 'TEXT'],
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: { voiceName: 'Aoede' },
                        },
                    },
                },
                systemInstruction: {
                    parts: [{ text: SYSTEM_PROMPT }],
                },
                tools: TOOLS_GEMINI,
                realtimeInputConfig: pushToTalk ? {
                    automaticActivityDetection: { disabled: true },
                } : {
                    automaticActivityDetection: {
                        disabled: false,
                        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
                        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
                        silenceDurationMs: 700,
                        prefixPaddingMs: 300,
                    },
                    activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
                },
            },
        });
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());

        if (msg.setupComplete) {
            console.log('[Gemini] Setup complete. Listening...');
            if (!pushToTalk) {
                micProc = startMicRecording(GEMINI_SAMPLE_RATE, (b64) => {
                    send({
                        realtimeInput: {
                            mediaChunks: [{
                                mimeType: 'audio/pcm;rate=16000',
                                data: b64,
                            }],
                        },
                    });
                });
            }
        }

        if (msg.serverContent) {
            const sc = msg.serverContent;
            if (sc.modelTurn?.parts) {
                for (const part of sc.modelTurn.parts) {
                    if (part.inlineData?.data) {
                        // Audio output — Gemini outputs at 24kHz
                        playAudio(part.inlineData.data, 24000);
                    }
                    if (part.text) {
                        process.stdout.write(part.text);
                    }
                }
            }
            if (sc.turnComplete) {
                console.log(); // newline
            }
        }

        if (msg.toolCall) {
            for (const fc of msg.toolCall.functionCalls || []) {
                console.log(`\n[Tool Call] ${fc.name}(${JSON.stringify(fc.args)})`);
                handleGeminiToolCall(fc.name, fc.args, fc.id, send);
            }
        }

        if (msg.inputTranscription?.text) {
            console.log(`[You] ${msg.inputTranscription.text}`);
        }

        if (msg.outputTranscription?.text) {
            process.stdout.write(msg.outputTranscription.text);
        }
    });

    ws.on('error', (err) => console.error('[Gemini] WS error:', err.message));
    ws.on('close', (code, reason) => {
        console.log(`[Gemini] WS closed: ${code} ${reason}`);
        if (micProc && !micProc.killed) micProc.kill();
        stopPlayback();
    });

    // Wait for setupComplete
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 15000);
        ws.on('message', function waitForSetup(data) {
            const msg = JSON.parse(data.toString());
            if (msg.setupComplete) {
                clearTimeout(timeout);
                ws.removeListener('message', waitForSetup);
                resolve();
            }
        });
    });

    return {
        ws,
        injectContext(text: string) {
            send({
                clientContent: {
                    turns: [{ role: 'model', parts: [{ text }] }],
                    turnComplete: false,
                },
            });
        },
        injectTextAndRespond(text: string) {
            send({
                clientContent: {
                    turns: [{ role: 'user', parts: [{ text }] }],
                    turnComplete: true,
                },
            });
        },
        cleanup() {
            if (micProc && !micProc.killed) micProc.kill();
            stopPlayback();
            if (ws.readyState === WebSocket.OPEN) ws.close();
        },
    };
}

// ---------------------------------------------------------------------------
// Tool call handlers (mock)
// ---------------------------------------------------------------------------

function handleToolCall(
    provider: string,
    name: string,
    argsJson: string,
    callId: string,
    send: (msg: any) => void,
    createResponseOrQueue: (fn: () => void) => void,
    onResponseStarted: () => void,
) {
    let args: any;
    try { args = JSON.parse(argsJson); } catch { args = argsJson; }

    console.log(`\n[Tool Call] ${name}(${JSON.stringify(args)})`);

    if (name === 'messageClaudeCode') {
        console.log(`  → Would send to Claude: "${args.message}"`);
        // Return a mock result
        send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ status: 'sent', message: args.message }),
            },
        });
        // Don't auto-respond — wait for mock Claude response from CLI
    } else if (name === 'processPermissionRequest') {
        console.log(`  → Permission ${args.decision} for request ${args.requestId}`);
        send({
            type: 'conversation.item.create',
            item: {
                type: 'function_call_output',
                call_id: callId,
                output: JSON.stringify({ status: args.decision, requestId: args.requestId }),
            },
        });
        createResponseOrQueue(() => {
            onResponseStarted();
            send({ type: 'response.create' });
        });
    }
}

function handleGeminiToolCall(name: string, args: any, callId: string, send: (msg: any) => void) {
    console.log(`\n[Tool Call] ${name}(${JSON.stringify(args)})`);

    if (name === 'messageClaudeCode') {
        console.log(`  → Would send to Claude: "${args.message}"`);
        send({
            toolResponse: {
                functionResponses: [{
                    id: callId,
                    response: { status: 'sent', message: args.message },
                }],
            },
        });
    } else if (name === 'processPermissionRequest') {
        console.log(`  → Permission ${args.decision} for request ${args.requestId}`);
        send({
            toolResponse: {
                functionResponses: [{
                    id: callId,
                    response: { status: args.decision, requestId: args.requestId },
                }],
            },
        });
    }
}

// ---------------------------------------------------------------------------
// CLI commands
// ---------------------------------------------------------------------------

function printHelp() {
    console.log(`
Commands:
  <text>              — Inject mock [CLAUDE] Response as a text message (GPT will speak it)
  /tool <name> <desc> — Inject mock [CLAUDE] Tool use notification
  /perm <id> <tool>   — Inject mock [CLAUDE] Permission request
  /ready              — Inject mock [CLAUDE] Ready event
  /context <text>     — Inject silent context (no response triggered)
  /quit               — Exit
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
    const args = process.argv.slice(2);
    const pushToTalk = args.includes('--push-to-talk');
    const modelArg = args.find(a => !a.startsWith('--'));

    if (!modelArg || !modelArg.includes(':')) {
        console.log('Usage: npx tsx voice-spike.ts <provider:model> [--push-to-talk]');
        console.log('');
        console.log('Providers:');
        console.log('  openai:gpt-realtime-mini');
        console.log('  openai:gpt-realtime-1.5');
        console.log('  gemini:gemini-2.0-flash-live-001');
        console.log('  gemini:gemini-2.5-flash-native-audio-preview');
        process.exit(1);
    }

    const [provider, model] = modelArg.split(':');

    let session: {
        ws: WebSocket;
        injectContext: (text: string) => void;
        injectTextAndRespond: (text: string) => void;
        cleanup: () => void;
    };

    if (provider === 'openai') {
        session = await connectOpenAI(model, pushToTalk);
    } else if (provider === 'gemini') {
        session = await connectGemini(model, pushToTalk);
    } else {
        console.error(`Unknown provider: ${provider}. Use 'openai' or 'gemini'.`);
        process.exit(1);
    }

    printHelp();

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '> ',
    });

    rl.prompt();

    rl.on('line', (line) => {
        const input = line.trim();
        if (!input) {
            rl.prompt();
            return;
        }

        if (input === '/quit') {
            session.cleanup();
            process.exit(0);
        }

        if (input === '/ready') {
            const text = '[CLAUDE] Ready: Claude Code finished working. Tell the user what was done.';
            session.injectTextAndRespond(text);
        } else if (input.startsWith('/perm ')) {
            const parts = input.slice(6).split(' ');
            const requestId = parts[0] || 'req_001';
            const toolName = parts[1] || 'Bash';
            const text = `[CLAUDE] Permission request (request_id: ${requestId}): Claude wants to use ${toolName} with arguments: {"command":"echo hello"}`;
            session.injectTextAndRespond(text);
        } else if (input.startsWith('/tool ')) {
            const rest = input.slice(6);
            const text = `[CLAUDE] Tool use: ${rest}`;
            session.injectContext(text);
            console.log(`Injected context: ${text}`);
        } else if (input.startsWith('/context ')) {
            const rest = input.slice(9);
            session.injectContext(rest);
            console.log(`Injected silent context: ${rest}`);
        } else {
            // Default: inject as [CLAUDE] Response
            const text = `[CLAUDE] Response: ${input}`;
            session.injectTextAndRespond(text);
        }

        rl.prompt();
    });

    rl.on('close', () => {
        session.cleanup();
        process.exit(0);
    });

    // Handle Ctrl+C
    process.on('SIGINT', () => {
        console.log('\nShutting down...');
        session.cleanup();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
