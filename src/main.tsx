import { createRoot } from 'react-dom/client'
import './styles/motion.css'
import './styles/glass.css'
import './styles/lp.css'
import './styles/v2.css'
import './styles/v3.css'
import './styles/team.css'
import './styles/island.css'
import './styles/capsule.css'
import { Desktop } from './mockup/Desktop'

// ?surface=dock|island|panel|palette|ascii|fx|all (fx: &fx=snow|rain|leaves|sunset|moon)
const surface = new URLSearchParams(location.search).get('surface') ?? 'all'
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

createRoot(document.getElementById('root')!).render(<Desktop only={surface === 'all' ? undefined : surface} />)
