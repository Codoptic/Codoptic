import type { CodeSpaceMessage } from '@/lib/code-space/core';

export type AgentRuntimeHistoryMessage = {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
};

export function appendInstructionToAgentPrompt(prompt: string, instruction: string): string {
  const trimmedInstruction = instruction.trim();
  if (!trimmedInstruction) return prompt;
  return `${prompt.trim()}\n\nAdditional user instructions:\n${trimmedInstruction}`.trim();
}

export function buildAgentRuntimeHistory(
  messages: CodeSpaceMessage[],
  latestUserMessageId: string,
  latestPromptContent: string,
  instruction: string,
): AgentRuntimeHistoryMessage[] {
  return messages.flatMap((message): AgentRuntimeHistoryMessage[] => {
    if (message.role === 'reasoning') return [];
    const content =
      message.role === 'user'
        ? appendInstructionToAgentPrompt(message.id === latestUserMessageId ? latestPromptContent : message.content, instruction)
        : message.content;
    return [{ role: message.role, content }];
  });
}
