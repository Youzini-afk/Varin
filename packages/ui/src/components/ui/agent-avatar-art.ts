import type { AgentAvatarId } from '@varin/protocol';

export interface AgentAvatarArt {
  body: string;
  color: string;
  accent?: { path: string; color: string };
  eyes: string;
  wink?: string;
}

// Flat silhouettes and punctuation-like eyes. Keep existing IDs/art stable when adding characters.
const bodies = {
  slope: 'M13 18Q15 14 21 13L43 8Q47 7 50 10L57 17Q59 19 59 24L61 47Q62 54 54 55L13 60Q6 61 7 53L10 26Q11 21 13 18Z',
  dome: 'M5 43C6 23 18 12 32 12C49 12 59 26 60 45Q61 51 54 52Q32 55 10 52Q3 52 5 43Z',
  taper: 'M15 13Q19 8 25 9L45 12Q51 13 53 20L61 48Q63 55 55 55L10 53Q3 53 5 46L11 23Q12 17 15 13Z',
  pebble: 'M7 28Q15 11 30 11L37 11Q49 12 56 27Q62 39 59 48Q57 55 47 56Q30 60 14 56Q5 54 4 44Q3 36 7 28Z',
  overlap: 'M11 18Q14 12 22 11L42 7Q48 6 49 13L51 28Q52 34 47 37L40 40Q35 42 36 47L37 52Q38 57 32 58L13 59Q6 59 6 51L8 28Q9 21 11 18Z',
  notch: 'M5 31Q9 13 28 12Q34 12 38 17Q41 21 48 21Q59 22 61 34L62 43Q63 54 50 55L18 55Q4 55 3 44Q2 37 5 31Z',
  slant: 'M11 19Q12 13 20 13L44 10Q50 9 53 16L61 43Q64 52 54 54L18 58Q10 59 8 51L5 29Q4 22 11 19Z',
  round: 'M11 17Q18 9 32 9Q48 9 55 20Q61 29 59 40Q56 55 42 58Q26 61 14 54Q4 48 4 34Q4 24 11 17Z',
  tile: 'M13 12Q18 9 26 9L49 11Q57 12 57 21L57 43Q57 47 53 51L47 56Q44 59 39 58L13 55Q6 54 6 45L6 24Q6 16 13 12Z',
  fold: 'M7 26Q8 18 16 16L43 9Q49 8 52 15L60 37Q63 46 55 50L32 58Q28 59 25 55L21 49Q19 46 14 47Q7 48 6 40Z',
  cap: 'M10 21Q15 12 27 10Q43 7 52 18Q58 25 60 40L60 46Q60 54 51 54L14 55Q5 55 5 47Q5 33 10 21Z',
  wave: 'M6 25Q11 15 25 16Q32 17 38 12Q44 7 51 14Q59 22 59 35L58 47Q57 55 47 56L16 56Q6 56 5 47L4 36Q3 30 6 25Z',
};
const eyes = {
  dash: 'M19 31L24 30Q27 30 27 32Q27 34 25 34L20 35Q17 35 17 33Q17 31 19 31ZM40 28L45 27Q48 27 48 29Q48 31 46 31L41 32Q38 32 38 30Q38 28 40 28Z',
  square: 'M21 29H24Q26 29 26 32V34Q26 36 23 36H21Q19 36 19 33V32Q19 29 21 29ZM41 29H44Q46 29 46 32V34Q46 36 43 36H41Q39 36 39 33V32Q39 29 41 29Z',
  calm: 'M18 31H24Q26 31 26 33Q26 35 24 35H18Q16 35 16 33Q16 31 18 31ZM40 31H46Q48 31 48 33Q48 35 46 35H40Q38 35 38 33Q38 31 40 31Z',
  curious: 'M20 30H23Q26 30 26 33V34Q26 37 23 37H20Q18 37 18 34V33Q18 30 20 30ZM40 33H46Q48 33 48 35Q48 37 46 37H40Q38 37 38 35Q38 33 40 33Z',
  attentive: 'M20 29Q23 29 23 32V35Q23 38 20 38Q18 38 18 35V32Q18 29 20 29ZM42 29Q45 29 45 32V35Q45 38 42 38Q40 38 40 35V32Q40 29 42 29Z',
  wink: 'M20 29L25 30Q27 30 27 32Q27 34 25 34L20 33Q18 33 18 31Q18 29 20 29Z',
};

export const AGENT_AVATAR_ART: Readonly<Record<AgentAvatarId, AgentAvatarArt>> = {
  'slope-lilac': { body: bodies.slope, color: '#C7B5EF', eyes: eyes.dash },
  'dome-ivory': { body: bodies.dome, color: '#E9DED0', eyes: eyes.square },
  'taper-sage': { body: bodies.taper, color: '#A8BD96', eyes: eyes.wink, wink: 'M40 33Q44 27 48 33' },
  'pebble-blue': { body: bodies.pebble, color: '#85B3D2', eyes: eyes.calm },
  'overlap-coral': { body: bodies.overlap, color: '#EE9583', eyes: eyes.curious,
    accent: { path: 'M33 20L47 17Q56 15 59 24L62 43Q64 52 56 54L29 56Z', color: '#C4746B' } },
  'notch-ochre': { body: bodies.notch, color: '#E9C16E', eyes: eyes.curious },
  'slant-mint': { body: bodies.slant, color: '#96C4B4', eyes: eyes.dash },
  'round-lilac': { body: bodies.round, color: '#B9ACD7', eyes: eyes.attentive },
  'tile-blue': { body: bodies.tile, color: '#91ADC8', eyes: eyes.square },
  'fold-sage': { body: bodies.fold, color: '#B2BDA2', eyes: eyes.calm },
  'cap-coral': { body: bodies.cap, color: '#DA9C99', eyes: eyes.attentive },
  'wave-ivory': { body: bodies.wave, color: '#DCD2BD', eyes: eyes.wink, wink: 'M40 33Q44 28 48 33' },
};

/** Standalone exports and preview boards use the same paths as the application. */
export function agentAvatarSvg(id: AgentAvatarId): string {
  const art = AGENT_AVATAR_ART[id];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${art.accent ? `<path fill="${art.accent.color}" d="${art.accent.path}"/>` : ''}<path fill="${art.color}" d="${art.body}"/><path fill="#202326" d="${art.eyes}"/>${art.wink ? `<path fill="none" stroke="#202326" stroke-width="4" stroke-linecap="round" d="${art.wink}"/>` : ''}</svg>`;
}
