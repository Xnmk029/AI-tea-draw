import type { PresetId, SvgEl, Transform } from '../core/types'
import { POLICY_PRESETS, sanitizeSvg, type PolicyReport } from '../core/svgPolicy'

/**
 * 模拟“Agent 产出的 SVG”素材库。全部画在 200×200 的盒子里。
 * 注意：部分素材故意带了 <title>/<text>/id/class，用来演示 Host 校验器的剥离效果。
 */

export type DrawingKey = 'tree' | 'teapot' | 'cat' | 'cloud' | 'sun' | 'mountain' | 'house' | 'flower' | 'bus' | 'cup'

export interface SceneItem extends Transform {
  key: DrawingKey
}

interface Drawing {
  label: string
  keywords: string[]
  svg: string
}

const K = '#3B3A36'

export const DRAWINGS: Record<DrawingKey, Drawing> = {
  tree: {
    label: '松树',
    keywords: ['松', '树', 'tree'],
    svg: `
      <rect x="92" y="150" width="16" height="40" rx="3" fill="#8B5E3C" stroke="${K}" stroke-width="3"/>
      <path d="M100 92 L168 160 L32 160 Z" fill="#3E7D5A" stroke="${K}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M100 56 L156 120 L44 120 Z" fill="#4C8F68" stroke="${K}" stroke-width="3" stroke-linejoin="round"/>
      <path d="M100 18 L142 82 L58 82 Z" fill="#5BA176" stroke="${K}" stroke-width="3" stroke-linejoin="round"/>`,
  },
  teapot: {
    label: '茶壶',
    keywords: ['茶壶', '壶', 'teapot'],
    svg: `
      <title>茶壶</title>
      <path d="M152 96 C186 96 186 142 150 142" fill="none" stroke="${K}" stroke-width="7" stroke-linecap="round"/>
      <path d="M54 104 C34 100 24 84 16 66 L28 62 C36 78 44 88 58 90" fill="#E7D3B8" stroke="${K}" stroke-width="3.5" stroke-linejoin="round"/>
      <path class="teapot-body" d="M50 92 C50 62 150 62 150 92 L150 128 C150 166 50 166 50 128 Z" fill="#E7D3B8" stroke="${K}" stroke-width="3.5"/>
      <path d="M58 112 C85 122 115 122 142 112" fill="none" stroke="#B5543C" stroke-width="5" stroke-linecap="round"/>
      <path d="M72 70 C78 48 122 48 128 70 Z" fill="#D6BE9C" stroke="${K}" stroke-width="3.5" stroke-linejoin="round"/>
      <circle cx="100" cy="46" r="7" fill="#B5543C" stroke="${K}" stroke-width="3"/>
      <path d="M84 34 C78 24 90 18 84 6" fill="none" stroke="#9AA6A0" stroke-width="3" stroke-linecap="round"/>
      <path d="M114 34 C108 24 120 18 114 6" fill="none" stroke="#9AA6A0" stroke-width="3" stroke-linecap="round"/>`,
  },
  cat: {
    label: '猫',
    keywords: ['猫', 'cat'],
    svg: `
      <path d="M146 150 C184 146 186 104 164 98" fill="none" stroke="#D99A5B" stroke-width="10" stroke-linecap="round"/>
      <ellipse id="cat-body" cx="100" cy="146" rx="50" ry="36" fill="#F2C48D" stroke="${K}" stroke-width="3.5"/>
      <path d="M68 72 L72 30 L96 54 Z" fill="#F2C48D" stroke="${K}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M132 72 L128 30 L104 54 Z" fill="#F2C48D" stroke="${K}" stroke-width="3.5" stroke-linejoin="round"/>
      <circle id="cat-head" cx="100" cy="84" r="38" fill="#F2C48D" stroke="${K}" stroke-width="3.5"/>
      <circle cx="86" cy="80" r="4.5" fill="${K}"/>
      <circle cx="114" cy="80" r="4.5" fill="${K}"/>
      <path d="M95 93 L100 98 L105 93 Z" fill="#D9578E" stroke="${K}" stroke-width="2" stroke-linejoin="round"/>
      <path d="M100 98 C100 106 91 107 89 102 M100 98 C100 106 109 107 111 102" fill="none" stroke="${K}" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M76 94 L52 90 M76 100 L54 104 M124 94 L148 90 M124 100 L146 104" fill="none" stroke="${K}" stroke-width="2" stroke-linecap="round"/>
      <text x="76" y="196" font-size="14">cat</text>`,
  },
  cloud: {
    label: '雨云',
    keywords: ['云', '雨', 'cloud'],
    svg: `
      <path d="M46 132 C20 132 18 98 44 96 C44 64 88 56 102 82 C112 60 152 64 152 94 C180 92 184 132 156 132 Z" fill="#FFFFFF" stroke="#7C93A3" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M62 150 L56 166 M92 150 L86 170 M122 150 L116 166 M148 148 L142 164" fill="none" stroke="#6FA3D6" stroke-width="3" stroke-linecap="round"/>`,
  },
  sun: {
    label: '太阳',
    keywords: ['太阳', '日', 'sun'],
    svg: `
      <path d="M100 44 L100 24 M100 156 L100 176 M44 100 L24 100 M156 100 L176 100 M60 60 L46 46 M140 60 L154 46 M60 140 L46 154 M140 140 L154 154" fill="none" stroke="#E0A83A" stroke-width="5" stroke-linecap="round"/>
      <circle cx="100" cy="100" r="36" fill="#F6C453" stroke="${K}" stroke-width="3.5"/>
      <circle cx="88" cy="94" r="3" fill="${K}"/>
      <circle cx="112" cy="94" r="3" fill="${K}"/>
      <path d="M86 106 C92 114 108 114 114 106" fill="none" stroke="${K}" stroke-width="3" stroke-linecap="round"/>`,
  },
  mountain: {
    label: '远山',
    keywords: ['山', 'mountain'],
    svg: `
      <path d="M6 172 L70 64 L104 120 L136 82 L196 172 Z" fill="#9BB8A6" stroke="${K}" stroke-width="3.5" stroke-linejoin="round"/>
      <path d="M70 64 L54 92 L64 86 L72 96 L82 84 L86 90 Z" fill="#FFFFFF" stroke="${K}" stroke-width="2.5" stroke-linejoin="round"/>
      <path d="M136 82 L124 98 L134 94 L140 101 L143 92 Z" fill="#FFFFFF" stroke="${K}" stroke-width="2.5" stroke-linejoin="round"/>`,
  },
  house: {
    label: '茶馆',
    keywords: ['茶馆', '房', '屋', '馆', 'house'],
    svg: `
      <rect x="48" y="96" width="104" height="76" fill="#F1E6D2" stroke="${K}" stroke-width="3.5"/>
      <path d="M22 98 C52 94 76 76 100 52 C124 76 148 94 178 98 L166 108 L34 108 Z" fill="#B5543C" stroke="${K}" stroke-width="3.5" stroke-linejoin="round"/>
      <rect x="86" y="128" width="28" height="44" rx="2" fill="#8B5E3C" stroke="${K}" stroke-width="3"/>
      <rect x="58" y="120" width="20" height="20" fill="#CFE3EA" stroke="${K}" stroke-width="3"/>
      <rect x="122" y="120" width="20" height="20" fill="#CFE3EA" stroke="${K}" stroke-width="3"/>
      <path d="M40 106 L40 114 M160 106 L160 114" fill="none" stroke="${K}" stroke-width="2"/>
      <ellipse cx="40" cy="122" rx="7" ry="9" fill="#E0614F" stroke="${K}" stroke-width="2.5"/>
      <ellipse cx="160" cy="122" rx="7" ry="9" fill="#E0614F" stroke="${K}" stroke-width="2.5"/>`,
  },
  flower: {
    label: '花',
    keywords: ['花', 'flower'],
    svg: `
      <path d="M100 190 C100 160 96 130 100 104" fill="none" stroke="#4C8F68" stroke-width="5" stroke-linecap="round"/>
      <path d="M99 160 C80 150 70 156 64 166 C80 172 92 168 99 160 Z" fill="#5BA176" stroke="${K}" stroke-width="2.5" stroke-linejoin="round"/>
      <circle cx="100" cy="58" r="16" fill="#F3A6B8" stroke="${K}" stroke-width="2.5"/>
      <circle cx="121" cy="73" r="16" fill="#F3A6B8" stroke="${K}" stroke-width="2.5"/>
      <circle cx="113" cy="98" r="16" fill="#F3A6B8" stroke="${K}" stroke-width="2.5"/>
      <circle cx="87" cy="98" r="16" fill="#F3A6B8" stroke="${K}" stroke-width="2.5"/>
      <circle cx="79" cy="73" r="16" fill="#F3A6B8" stroke="${K}" stroke-width="2.5"/>
      <circle cx="100" cy="80" r="11" fill="#F6C453" stroke="${K}" stroke-width="2.5"/>`,
  },
  bus: {
    label: '公交',
    keywords: ['公交', '巴士', '车', 'bus'],
    svg: `
      <rect x="18" y="62" width="164" height="88" rx="14" fill="#F6C453" stroke="${K}" stroke-width="3.5"/>
      <rect x="30" y="74" width="30" height="28" rx="4" fill="#CFE3EA" stroke="${K}" stroke-width="3"/>
      <rect x="68" y="74" width="30" height="28" rx="4" fill="#CFE3EA" stroke="${K}" stroke-width="3"/>
      <rect x="106" y="74" width="30" height="28" rx="4" fill="#CFE3EA" stroke="${K}" stroke-width="3"/>
      <rect x="144" y="74" width="26" height="28" rx="4" fill="#CFE3EA" stroke="${K}" stroke-width="3"/>
      <path d="M20 120 L180 120" fill="none" stroke="#E0614F" stroke-width="5"/>
      <circle cx="56" cy="152" r="14" fill="${K}"/>
      <circle cx="146" cy="152" r="14" fill="${K}"/>
      <circle cx="56" cy="152" r="5" fill="#E7E2D8"/>
      <circle cx="146" cy="152" r="5" fill="#E7E2D8"/>`,
  },
  cup: {
    label: '茶杯',
    keywords: ['杯', '茶', 'cup'],
    svg: `
      <ellipse cx="100" cy="184" rx="72" ry="9" fill="#E7D3B8" stroke="${K}" stroke-width="3"/>
      <path d="M156 98 C186 98 186 138 150 138" fill="none" stroke="${K}" stroke-width="6" stroke-linecap="round"/>
      <path d="M40 82 L160 82 L148 150 C146 164 136 172 122 172 L78 172 C64 172 54 164 52 150 Z" fill="#FFFFFF" stroke="${K}" stroke-width="3.5" stroke-linejoin="round"/>
      <ellipse cx="100" cy="82" rx="60" ry="10" fill="#C9A15A" stroke="${K}" stroke-width="3"/>
      <path d="M66 118 C78 126 90 110 102 118 C114 126 126 110 136 118" fill="none" stroke="#4F7F62" stroke-width="3" stroke-linecap="round"/>
      <path d="M86 60 C80 50 92 44 86 32" fill="none" stroke="#9AA6A0" stroke-width="3" stroke-linecap="round"/>
      <path d="M112 60 C106 50 118 44 112 32" fill="none" stroke="#9AA6A0" stroke-width="3" stroke-linecap="round"/>`,
  },
}

const cache = new Map<string, PolicyReport>()

/** 素材经过 Host 校验器后的结果（带缓存） */
export function drawingReport(key: DrawingKey, preset: PresetId = 'loose'): PolicyReport {
  const k = `${key}:${preset}`
  let r = cache.get(k)
  if (!r) {
    r = sanitizeSvg(DRAWINGS[key].svg, POLICY_PRESETS[preset])
    cache.set(k, r)
  }
  return r
}

export const drawingEls = (key: DrawingKey, preset: PresetId = 'loose'): SvgEl[] => drawingReport(key, preset).elements

/** 根据指令文本挑一个素材（模拟 Agent 理解指令） */
export function matchDrawing(text: string): DrawingKey {
  for (const [k, d] of Object.entries(DRAWINGS)) if (d.keywords.some((w) => text.includes(w))) return k as DrawingKey
  const keys = Object.keys(DRAWINGS) as DrawingKey[]
  return keys[Math.floor(Math.random() * keys.length)]
}
