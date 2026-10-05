import { createElement } from 'react'
import type { SvgEl } from '../core/types'

export const renderEl = (el: SvgEl, extra: Record<string, unknown> = {}) => createElement(el.tag, { ...el.attrs, ...extra })
