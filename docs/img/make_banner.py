"""Builds docs/img/banner-dark.svg and docs/img/banner-light.svg for the README.

A tool call travels from the agent through the policy check, waits at the person's approval
gate, gets a one-time permit and lands in the hash-chained log. It plays three times and then
stops; with reduced motion the banner stands still. Run: python3 docs/img/make_banner.py
"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
THEMES = {
    "dark":  dict(bg="#05061a", line="#1f2a40", ink="#e8eefc", sub="#a9b6d3", cyan="#4de2ff", violet="#a78bfa", green="#34d399", amber="#f7c873", chip="#0b1230"),
    "light": dict(bg="#f7f9ff", line="#d5dcec", ink="#0b1230", sub="#4a5675", cyan="#0a7f93", violet="#6d3fe0", green="#047857", amber="#9a6100", chip="#ffffff"),
}
SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
W, H = 1200, 320
# (x, label, small line, colour key)
STOPS = [(120, "AI agent", "tool call", "cyan"), (370, "Policy", "risk and scope", "cyan"),
         (620, "A person", "approves this request", "amber"), (870, "Permit", "once, then expires", "green"),
         (1080, "Audit log", "hash-chained", "violet")]
Y = 228
LOOP = 6.0   # seconds per pass; the dot holds at the person for a moment


def svg(c):
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="t d">',
         '<title id="t">MCP Human Approval Gateway</title>',
         '<desc id="d">A tool call from an AI agent passes the policy check, waits for a named person to approve that exact request, '
         'gets a permit that can be used once and expires, and every decision is written to a hash-chained log. 210 scripted checks.</desc>',
         ('<style>'
          f'.pkt{{offset-path:path("M{STOPS[0][0]} {Y} H{STOPS[-1][0]}");animation:pkt {LOOP}s linear .5s 3 both}}'
          '@keyframes pkt{0%{offset-distance:0%;opacity:0}4%{opacity:1}'
          '50%{offset-distance:52.1%}66%{offset-distance:52.1%}'   # waits at the person
          '96%{offset-distance:100%;opacity:1}100%{offset-distance:100%;opacity:0}}'
          f'.gate{{transform-box:fill-box;transform-origin:center;animation:gate {LOOP}s ease-out .5s 3 both}}'
          '@keyframes gate{0%,48%{transform:scale(1);opacity:.16}56%{transform:scale(1.6);opacity:.4}66%,100%{transform:scale(1);opacity:.16}}'
          f'.ok{{animation:ok {LOOP}s ease-out .5s 3 both}}'
          '@keyframes ok{0%,60%{opacity:0}66%,100%{opacity:1}}'
          '@media (prefers-reduced-motion: reduce){.pkt{display:none}.gate,.ok{animation:none}.ok{opacity:1}}'
          '</style>'),
         f'<rect width="{W}" height="{H}" rx="18" fill="{c["bg"]}"/>',
         f'<rect x=".5" y=".5" width="{W - 1}" height="{H - 1}" rx="18" fill="none" stroke="{c["line"]}"/>',
         f'<g font-family="{SANS}">',
         f'<text x="56" y="64" font-family="{MONO}" font-size="15" letter-spacing="3" fill="{c["cyan"]}">MODEL CONTEXT PROTOCOL · HTTP AND STDIO · 210 CHECKS</text>',
         f'<text x="56" y="118" font-size="46" font-weight="800" fill="{c["ink"]}">MCP Human Approval Gateway</text>',
         f'<text x="56" y="154" font-size="20" fill="{c["sub"]}">When an AI agent wants to do something risky, a named person says yes, and you can prove it later.</text>',
         f'<line x1="{STOPS[0][0]}" y1="{Y}" x2="{STOPS[-1][0]}" y2="{Y}" stroke="{c["line"]}" stroke-width="3" stroke-linecap="round"/>']
    for x, label, small, col in STOPS:
        if label == "A person":
            o.append(f'<circle class="gate" cx="{x}" cy="{Y}" r="22" fill="{c["amber"]}" fill-opacity="1" opacity=".16"/>')
        o.append(f'<circle cx="{x}" cy="{Y}" r="11" fill="{c["bg"]}" stroke="{c[col]}" stroke-width="3"/>')
        o.append(f'<text x="{x}" y="{Y + 44}" text-anchor="middle" font-size="18" font-weight="700" fill="{c[col] if label == "A person" else c["ink"]}">{label}</text>')
        o.append(f'<text x="{x}" y="{Y + 66}" text-anchor="middle" font-size="14" fill="{c["sub"]}">{small}</text>')
    px = STOPS[2][0]
    o.append(f'<g class="ok"><rect x="{px - 46}" y="{Y - 58}" width="92" height="28" rx="14" fill="{c["chip"]}" stroke="{c["green"]}"/>'
             f'<text x="{px}" y="{Y - 39}" text-anchor="middle" font-size="14" font-weight="700" fill="{c["green"]}">approved</text></g>')
    o.append(f'<circle class="pkt" cx="0" cy="0" r="6.5" fill="{c["cyan"]}"/>')
    o += ['</g>', '</svg>']
    return "\n".join(o) + "\n"


for name, c in THEMES.items():
    with open(os.path.join(HERE, f"banner-{name}.svg"), "w", encoding="utf-8") as f:
        f.write(svg(c))
print("banner written")
