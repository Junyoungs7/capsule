/* 시안(win-tray-v3)의 선 아이콘 — 24×24, currentColor */
const P: Record<string, string> = {
  laptop: 'M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v9H3V7a1.5 1.5 0 0 1 1.5-1.5zM1.5 19.5h21',
  clip: 'M9 3h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM8 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2',
  ripple: 'M12 10a2 2 0 1 1 0 4a2 2 0 0 1 0-4zM12 6a6 6 0 1 1 0 12a6 6 0 0 1 0-12zM12 2a10 10 0 1 1 0 20a10 10 0 0 1 0-20z',
  cursor: 'M5 3l6 16 2.5-6.5L20 10zM17 17l4 4',
  send: 'M4 12h14M13 6l6 6-6 6',
  open: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  x: 'M6 6l12 12M18 6L6 18',
  gear: 'M12 9a3 3 0 1 1 0 6a3 3 0 0 1 0-6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  shelf: 'M3 8h18M5 8v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9 12h6M7 8l1.5-3h7L17 8',
  down: 'M12 4v12M6 10l6 6 6-6M4 20h16',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  home: 'M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  info: 'M12 2a10 10 0 1 1 0 20a10 10 0 0 1 0-20zM12 11v6M12 7.5v.5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  play: 'M7 5l12 7-12 7z',
  minus: 'M5 12h14',
  plus: 'M12 5v14M5 12h14',
  chat: 'M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-5 4V6a1 1 0 0 1 1-1z',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z',
}
export type IcoKey = keyof typeof P
export const Ico = ({ k, w = 1.7 }: { k: IcoKey; w?: number }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={P[k]} /></svg>
)
