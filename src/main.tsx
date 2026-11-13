import { createRoot } from 'react-dom/client'
import './styles/motion.css'
import './styles/glass.css'
import './styles/turntable.css'
import { Desktop } from './mockup/Desktop'

// ?surface=dock|island|panel|turntable|palette|all
const surface = new URLSearchParams(location.search).get('surface') ?? 'all'
document.documentElement.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'

createRoot(document.getElementById('root')!).render(<Desktop only={surface === 'all' ? undefined : surface} />)
