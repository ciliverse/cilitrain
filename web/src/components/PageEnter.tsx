import { useLocation } from 'react-router-dom'

export default function PageEnter({ children }: { children: React.ReactNode }) {
  const loc = useLocation()
  return (
    <div key={loc.pathname} className="page-enter">
      {children}
    </div>
  )
}
