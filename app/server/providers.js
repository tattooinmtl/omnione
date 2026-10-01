// Provider catalog. The frontend reads the same chart via /api/providers.

export const PROVIDERS = [
  {
    id: 'minimax',
    label: 'MiniMax',
    defaultModel: 'MiniMax-M3.1-Flash-Preview',
    defaultMaxTokens: 131072,
    maxContextTokens: 1000000,
    maxToolCalls: 200,
    free: false,
    builtIn: false,
    baseUrl: 'https://api.minimax.io/v1',
    apiStyle: 'openai',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4o',
    defaultMaxTokens: 16384,
    maxContextTokens: 128000,
    maxToolCalls: null,
    free: false,
    baseUrl: 'https://api.openai.com/v1',
    apiStyle: 'openai',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-5',
    defaultMaxTokens: 64000,
    maxContextTokens: 200000,
    maxToolCalls: null,
    free: false,
    baseUrl: 'https://api.anthropic.com/v1',
    apiStyle: 'anthropic',
  },
  {
    id: 'gwn-local',
    label: 'OmniOne Local (no key)',
    defaultModel: 'gwn-stub',
    defaultMaxTokens: 8192,
    maxContextTokens: 32000,
    maxToolCalls: 0,
    free: true,
    builtIn: true,
    apiStyle: 'stub',
  },
];

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}
