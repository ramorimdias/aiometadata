/** Older setup clients may omit a newer option. Explicit false still disables it. */
export function preserveAiNaming(config: any, previous: any): any {
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      config.recommendations?.ai_names !== undefined ||
      typeof previous?.recommendations?.ai_names !== 'boolean') return config;
  return { ...config, recommendations: {
    ...config.recommendations, ai_names: previous.recommendations.ai_names,
  } };
}
module.exports = { preserveAiNaming };
