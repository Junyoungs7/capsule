import { createRoot } from 'react-dom/client'
import './styles/motion.css'
import './styles/glass.css'
import './styles/lp.css'
import './styles/v2.css'
import './styles/v3.css'
import './styles/team.css'
import './styles/island.css'
import './styles/capsule.css'
import './styles/a6.css'
import { Desktop } from './mockup/Desktop'
import { installMotion } from './motion'

// ?surface=dock|island|panel|palette|ascii|fx|all (fx: &fx=snow|rain|leaves|sunset|moon)
const surface = new URLSearchParams(location.search).get('surface') ?? 'all'
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

installMotion() // (a6) 모션 팩: 변수·알약·스위치·떠오르기 (동작 줄이기면 꺼짐)
createRoot(document.getElementById('root')!).render(<Desktop only={surface === 'all' ? undefined : surface} />)
