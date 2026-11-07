/** Official site icons. Custom has no vendor, so it stays a plus. */

const SRC: Record<string, string> = {
  kimi: '/providers/kimi.png',
  deepseek: '/providers/deepseek.svg',
  qwen: '/providers/qwen.svg',
  doubao: '/providers/doubao.png',
  zhipu: '/providers/zhipu.png',
  minimax: '/providers/minimax.png',
  stepfun: '/providers/stepfun.png',
  hunyuan: '/providers/hunyuan.png',
  openai: '/providers/openai.png',
  claude: '/providers/claude.svg',
  gemini: '/providers/gemini.png',
  grok: '/providers/grok.png',
  groq: '/providers/groq.svg',
  ollama: '/providers/ollama.png',
}

export default function ProviderMark({ id }: { id: string }) {
  const src = SRC[id]
  if (!src) {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path fill="currentColor" d="M15 8h2v6h6v2h-6v6h-2v-6H9v-2h6z" />
      </svg>
    )
  }
  return <img src={src} alt="" />
}
