import { createRoot } from 'react-dom/client'
import './styles/motion.css'
import './styles/glass.css'
import './styles/lp.css'
import './styles/v2.css'
import './styles/v3.css'
import './styles/team.css'
import './styles/hub.css'
import { Desktop } from './mockup/Desktop'
import { HubDesktop } from './mockup/Hub'

// ?surface=dock|island|panel|palette|ascii|fx|all (fx: &fx=snow|rain|leaves|sunset|moon)
// 한 파일 빌드(아티팩트)는 쿼리 없이 열린다 → window.__HERA_SURFACE 로 기본 표면 지정
const surface = new URLSearchParams(location.search).get('surface') ?? (window as { __HERA_SURFACE?: string }).__HERA_SURFACE ?? 'all'
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

// ?surface=hub: 독 없음 · Island 허브 시안
createRoot(document.getElementById('root')!).render(surface === 'hub' ? <HubDesktop /> : <Desktop only={surface === 'all' ? undefined : surface} />)
