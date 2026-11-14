/**
 * Allow-list SVG sanitiser. It tokenises the markup and REBUILDS the output from
 * allow-listed elements and attributes, so nothing the input says can survive
 * unless it is named here. Chosen over DOMPurify because it needs no new
 * dependency (DOMPurify is only a transitive dep of mermaid) and, being string
 * based, it also runs in the node test environment and in workers.
 *
 * Dropped: script, foreignObject, animate/set, image, a, iframe/object/embed,
 * every on* attribute, href other than same-document "#id" on <use>, any
 * url() that is not "#id", @import, and style rules containing those.
 */
const MAX_INPUT = 2_000_000;
const MAX_DEPTH = 64;

const ELEMENTS = new Set((
  "svg g defs symbol use title desc path rect circle ellipse line polyline polygon text tspan textpath " +
  "marker lineargradient radialgradient stop clippath mask pattern style filter feblend fecolormatrix " +
  "fecomposite feflood fegaussianblur femerge femergenode feoffset fedropshadow femorphology " +
  "fecomponenttransfer fefunca fefuncb fefuncg fefuncr feturbulence fedisplacementmap feimage"
).split(" "));
const CAMEL: Record<string, string> = {
  lineargradient: "linearGradient", radialgradient: "radialGradient", clippath: "clipPath", textpath: "textPath",
  fegaussianblur: "feGaussianBlur", fecolormatrix: "feColorMatrix", feblend: "feBlend", fecomposite: "feComposite",
  feflood: "feFlood", femerge: "feMerge", femergenode: "feMergeNode", feoffset: "feOffset", fedropshadow: "feDropShadow",
  femorphology: "feMorphology", fecomponenttransfer: "feComponentTransfer", fefunca: "feFuncA", fefuncb: "feFuncB",
  fefuncg: "feFuncG", fefuncr: "feFuncR", feturbulence: "feTurbulence", fedisplacementmap: "feDisplacementMap", feimage: "feImage",
};
/** Elements whose whole subtree is discarded (not just the tag). */
const DROP_SUBTREE = new Set(["script", "foreignobject", "animate", "set", "animatetransform", "animatemotion", "image", "iframe", "object", "embed", "noscript", "template", "audio", "video", "canvas", "math", "feimage"]);
const VOID_OR_SELF = new Set(["br", "hr", "img", "input", "meta", "link", "base", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "title", "textarea", "xmp", "noscript"]);

const SAFE_ATTR = /^(?:[a-z][a-z0-9-]*|xml:space|xlink:href|xmlns(?::xlink)?)$/i;
const URL_ATTR = new Set(["href", "xlink:href"]);

function decode(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos|tab|newline|colon));?/gi, (_m, hex, dec, name) => {
    if (name) return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", tab: "\t", newline: "\n", colon: ":" } as Record<string, string>)[name.toLowerCase()]!;
    const code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}
const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (value: string) => escapeText(value).replace(/"/g, "&quot;");
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/** True when every url(...) in a CSS/attribute value points at a same-document id. */
function urlsAreLocal(value: string): boolean {
  const flat = value.replace(/\s+/g, "").replace(/\\/g, "\\");
  for (const match of flat.matchAll(/url\(([^)]*)\)?/gi)) {
    if (!/^["']?#[\w.:-]+["']?$/.test(match[1]!)) return false;
  }
  return true;
}
function unsafeCss(value: string): boolean {
  const flat = value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
  return /@import|expression\(|javascript:|vbscript:|behavior:|-moz-binding|\\|<|data:|image-set|src\(/i.test(flat) || !urlsAreLocal(flat);
}

function cleanAttribute(tag: string, name: string, raw: string): string | undefined {
  const lower = name.toLowerCase();
  if (lower.startsWith("on") || !SAFE_ATTR.test(name)) return undefined;
  const value = decode(raw).replace(STRIP, "");
  if (URL_ATTR.has(lower)) return tag === "use" && /^#[\w.:-]+$/.test(value.trim()) ? value.trim() : undefined;
  if (lower === "style") {
    // Keep only declarations whose value is safe.
    const kept = value.split(";").filter((decl) => decl.includes(":") && !unsafeCss(decl)).join(";");
    return kept || undefined;
  }
  if (lower.startsWith("xmlns")) return /^http:\/\/www\.w3\.org\/(2000\/svg|1999\/xlink)$/.test(value) ? value : undefined;
  if (/javascript:|vbscript:|data:/i.test(value.replace(/\s+/g, "")) || !urlsAreLocal(value)) return undefined;
  return value.slice(0, 20_000);
}

const closeTag = (name: string) => `</${CAMEL[name] ?? name}>`;

export function sanitizeSvg(input: string): string {
  const source = String(input).slice(0, MAX_INPUT);
  const out: string[] = [];
  const stack: string[] = [];
  let skip = 0; // depth inside a dropped subtree
  let i = 0;
  const n = source.length;
  while (i < n) {
    const lt = source.indexOf("<", i);
    if (lt === -1) { if (!skip) out.push(escapeText(decode(source.slice(i)).replace(STRIP, " "))); break; }
    if (lt > i && !skip) out.push(escapeText(decode(source.slice(i, lt)).replace(STRIP, " ")));
    i = lt;
    if (source.startsWith("<!--", i)) { const end = source.indexOf("-->", i + 4); i = end === -1 ? n : end + 3; continue; }
    if (source.startsWith("<![CDATA[", i)) { const end = source.indexOf("]]>", i + 9); i = end === -1 ? n : end + 3; continue; }
    if (source[i + 1] === "!" || source[i + 1] === "?") { const end = source.indexOf(">", i); i = end === -1 ? n : end + 1; continue; }
    const closing = source[i + 1] === "/";
    const nameMatch = /^[a-z][a-z0-9:-]*/i.exec(source.slice(i + (closing ? 2 : 1), i + 80));
    if (!nameMatch) { if (!skip) out.push("&lt;"); i += 1; continue; }
    const rawName = nameMatch[0];
    const name = rawName.toLowerCase().replace(/^svg:/, "");
    let j = i + (closing ? 2 : 1) + rawName.length;
    // Scan attributes, honouring quotes.
    const attrs: Array<[string, string]> = [];
    let selfClosing = false;
    while (j < n) {
      while (j < n && /\s/.test(source[j]!)) j++;
      if (j >= n) break;
      const ch = source[j]!;
      if (ch === ">") { j++; break; }
      if (ch === "/") { if (source[j + 1] === ">") { selfClosing = true; j += 2; break; } j++; continue; }
      const attr = /^[^\s=/>]+/.exec(source.slice(j, j + 200));
      if (!attr) { j++; continue; }
      j += attr[0].length;
      while (j < n && /\s/.test(source[j]!)) j++;
      let value = "";
      if (source[j] === "=") {
        j++;
        while (j < n && /\s/.test(source[j]!)) j++;
        const quote = source[j];
        if (quote === '"' || quote === "'") {
          const end = source.indexOf(quote, j + 1);
          value = source.slice(j + 1, end === -1 ? n : end);
          j = end === -1 ? n : end + 1;
        } else {
          const bare = /^[^\s>]*/.exec(source.slice(j, j + 5000))![0];
          value = bare; j += bare.length;
        }
      }
      if (attrs.length < 100) attrs.push([attr[0], value]);
    }
    if (closing) {
      if (skip) { skip--; i = j; continue; }
      const at = stack.lastIndexOf(name);
      if (at !== -1) while (stack.length > at) out.push(closeTag(stack.pop()!));
      i = j;
      continue;
    }
    if (RAW_TEXT.has(name)) {
      // Raw-text content is never parsed as markup.
      const end = source.toLowerCase().indexOf(`</${name}`, j);
      const body = source.slice(j, end === -1 ? n : end);
      const close = end === -1 ? n : source.indexOf(">", end);
      i = close === -1 ? n : close + 1;
      if (!skip && name === "style" && ELEMENTS.has("style") && !unsafeCss(body) && body.length <= 100_000 && stack.length < MAX_DEPTH) {
        out.push(`<style>${escapeText(body.replace(STRIP, " "))}</style>`);
      } else if (!skip && name === "title" && stack.length < MAX_DEPTH) {
        out.push(`<title>${escapeText(decode(body).replace(STRIP, " "))}</title>`);
      }
      continue;
    }
    if (skip) { if (!selfClosing && !VOID_OR_SELF.has(name)) skip++; i = j; continue; }
    if (DROP_SUBTREE.has(name)) { if (!selfClosing && !VOID_OR_SELF.has(name)) skip = 1; i = j; continue; }
    if (ELEMENTS.has(name) && stack.length < MAX_DEPTH) {
      const tag = CAMEL[name] ?? name;
      let html = `<${tag}`;
      for (const [attrName, value] of attrs) {
        const cleaned = cleanAttribute(name, attrName, value);
        if (cleaned !== undefined) html += ` ${attrName}="${escapeAttr(cleaned)}"`;
      }
      if (name === "svg" && stack.length === 0 && !attrs.some(([a]) => a.toLowerCase() === "xmlns")) html += ' xmlns="http://www.w3.org/2000/svg"';
      if (selfClosing) out.push(`${html}/>`);
      else { out.push(`${html}>`); stack.push(name); }
    }
    // Unknown elements lose their tag but keep (escaped) text children.
    i = j;
  }
  while (stack.length) out.push(closeTag(stack.pop()!));
  return out.join("");
}
