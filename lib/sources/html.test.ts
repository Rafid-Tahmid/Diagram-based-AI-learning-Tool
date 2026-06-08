import { describe, it, expect } from 'vitest'
import { stripHtml } from './html'

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>world</b></p>')).toBe('Hello world')
  })

  it('drops script and style blocks entirely', () => {
    expect(stripHtml('a<script>var x=1<2;</script>b<style>.c{}</style>d')).toBe('a b d')
  })

  it('decodes common entities', () => {
    expect(stripHtml('a &amp; b &lt;t&gt; &quot;q&quot; &#39;s&#39;')).toBe('a & b <t> "q" \'s\'')
  })

  it('decodes numeric entities', () => {
    expect(stripHtml('caf&#233;')).toBe('café')
  })

  it('trims surrounding whitespace', () => {
    expect(stripHtml('   <div>  x  </div>   ')).toBe('x')
  })
})
