// Icon components — minimal stroke icons
const Icon = {
  Dashboard: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2" width="5" height="5" rx="1"/>
      <rect x="9" y="2" width="5" height="5" rx="1"/>
      <rect x="2" y="9" width="5" height="5" rx="1"/>
      <rect x="9" y="9" width="5" height="5" rx="1"/>
    </svg>
  ),
  Projects: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M2 4.5L2 12.5C2 13 2.5 13.5 3 13.5L13 13.5C13.5 13.5 14 13 14 12.5L14 5.5C14 5 13.5 4.5 13 4.5L8 4.5L6.5 3L3 3C2.5 3 2 3.5 2 4.5Z"/>
    </svg>
  ),
  Agents: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="5.5" cy="6" r="2"/>
      <circle cx="11" cy="6" r="1.6"/>
      <path d="M2 13C2 11 3.5 9.5 5.5 9.5C7.5 9.5 9 11 9 13"/>
      <path d="M9.5 13C9.5 11.5 10.5 10 12 10C13.4 10 14 11 14 12"/>
    </svg>
  ),
  Tracker: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="2" y="2.5" width="3.5" height="11" rx="1"/>
      <rect x="6.5" y="2.5" width="3.5" height="7" rx="1"/>
      <rect x="11" y="2.5" width="3.5" height="9" rx="1"/>
    </svg>
  ),
  Logs: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 4H13"/>
      <path d="M3 8H10"/>
      <path d="M3 12H12"/>
    </svg>
  ),
  ChevronLeft: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 12L6 8L10 4"/>
    </svg>
  ),
  ChevronRight: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4L10 8L6 12"/>
    </svg>
  ),
  // Drawer width presets — a viewport frame with a right-side panel that fills
  // more (wide), half (half), or less (narrow) of the frame.
  DrawerWide: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="1.5" y="2" width="13" height="12" rx="1.5"/>
      <rect x="3.5" y="3.5" width="9.5" height="9" rx="0.5" fill="currentColor" fillOpacity="0.28" stroke="none"/>
      <line x1="3.5" y1="2" x2="3.5" y2="14"/>
    </svg>
  ),
  DrawerHalf: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="1.5" y="2" width="13" height="12" rx="1.5"/>
      <rect x="8" y="3.5" width="5" height="9" rx="0.5" fill="currentColor" fillOpacity="0.28" stroke="none"/>
      <line x1="8" y1="2" x2="8" y2="14"/>
    </svg>
  ),
  DrawerNarrow: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
      <rect x="1.5" y="2" width="13" height="12" rx="1.5"/>
      <rect x="11.5" y="3.5" width="1.5" height="9" rx="0.5" fill="currentColor" fillOpacity="0.28" stroke="none"/>
      <line x1="11.5" y1="2" x2="11.5" y2="14"/>
    </svg>
  ),
  Close: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M4 4L12 12M12 4L4 12"/>
    </svg>
  ),
  Clock: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6"/>
      <path d="M8 5V8L10 9.5" strokeLinecap="round"/>
    </svg>
  ),
  Tool: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2.5L13.5 5L11.5 7L9 4.5L11 2.5Z"/>
      <path d="M9 4.5L3 10.5V13H5.5L11.5 7"/>
    </svg>
  ),
  Search: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="7" cy="7" r="4.5"/>
      <path d="M10.5 10.5L13.5 13.5" strokeLinecap="round"/>
    </svg>
  ),
  Spark: ({ size = 60 }) => (
    <svg width={size} height={size * 0.4} viewBox="0 0 60 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M0 18L8 14L14 16L20 9L26 12L32 6L38 10L44 4L50 8L60 2"/>
    </svg>
  ),
  Activity: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 8H4L6 3L10 13L12 8H15"/>
    </svg>
  ),
  Gate: ({ size = 12 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 14V5L8 2L13 5V14"/>
      <path d="M3 14H13"/>
      <path d="M6.5 14V8.5H9.5V14"/>
    </svg>
  ),
  // TKT-0206: ideas-stack anchor icon (lightbulb).
  Lightbulb: ({ size = 14 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6"/>
      <path d="M10 22h4"/>
      <path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1.1 1.9l.4 1.4h5l.4-1.4c.1-.7.5-1.4 1.1-1.9A7 7 0 0 0 12 2z"/>
    </svg>
  ),
  Gear: ({ size = 16, className }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.04-.32.07-.64.07-.97 0-.33-.03-.66-.07-1l2.11-1.63a.49.49 0 0 0 .12-.61l-2-3.46a.49.49 0 0 0-.59-.22l-2.49 1a7.49 7.49 0 0 0-1.72-1L14.94 2.5a.49.49 0 0 0-.49-.5H10.5a.49.49 0 0 0-.49.5l-.39 2.61c-.65.18-1.26.47-1.81.86l-2.48-1a.49.49 0 0 0-.6.22l-2 3.46c-.13.22-.07.49.12.61L5.6 11c-.04.34-.07.67-.07 1s.03.65.07.97l-2.11 1.63a.49.49 0 0 0-.12.61l2 3.46a.49.49 0 0 0 .59.22l2.49-1.01c.53.4 1.12.71 1.76.92L9.53 21.5c.04.27.27.5.49.5h3.88a.49.49 0 0 0 .49-.5l.39-2.61c.64-.21 1.23-.52 1.76-.92l2.49 1.01a.49.49 0 0 0 .59-.22l2-3.46a.49.49 0 0 0-.12-.61l-2.12-1.66Z"/>
    </svg>
  ),
  Archive: ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5V13C2 13.5 2.5 14 3 14H13C13.5 14 14 13.5 14 13V4.5"/>
      <path d="M1 2.5H15"/>
      <path d="M6 8H10"/>
    </svg>
  ),
};

window.Icon = Icon;
