import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import CodeMirror from '@uiw/react-codemirror'
import { resolveTheme } from '../theme'
import { useTheme } from '../useTheme'

const chrome = EditorView.theme({
  '&': {
    fontSize: '13px',
    height: '28rem',
  },
  '.cm-scroller': {
    fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
    lineHeight: '1.55',
  },
  '.cm-content': {
    padding: '0.7rem 0',
  },
  '&.cm-focused': {
    outline: 'none',
  },
})

export default function ScriptEditor({
  value,
  onChange,
}: {
  value: string
  onChange: (next: string) => void
}) {
  const { theme, prefersDark } = useTheme()
  const dark = resolveTheme(theme, prefersDark) === 'dark'

  return (
    <div className="script-editor">
      <CodeMirror
        value={value}
        height="28rem"
        extensions={[python(), chrome]}
        theme={dark ? oneDark : 'light'}
        onChange={onChange}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLine: true,
        }}
      />
    </div>
  )
}
