import type { SignalDef } from "../../config/types.js";

// D-16: el nucleo trabaja en unidades de ingenieria, la conversion a crudo
// vive solo aqui, en el borde Modbus. Escalado lineal simple; el Type Code
// real de cada canal ADAM no esta confirmado (PEND-06).

function requireRawDef(def: SignalDef): { range: [number, number]; rawRange: [number, number] } {
  if (!def.range || !def.raw) {
    throw new Error(`"${def.id}" no tiene "range"/"raw": no es una señal analogica valida`);
  }
  return { range: def.range, rawRange: def.raw.raw_range };
}

// modbus-serial siempre entrega/espera el registro como palabra sin signo de
// 16 bits (ver servers/servertcp_handler.js: readUInt16BE/writeUInt16BE). Para
// rangos crudos bipolares (p.ej. -32768..32767) hay que pasar por el
// complemento a dos a mano.
function unsignedWordToSignedIfNeeded(word: number, rawRange: [number, number]): number {
  if (rawRange[0] >= 0) return word;
  return word >= 0x8000 ? word - 0x10000 : word;
}

function signedToUnsignedWord(raw: number): number {
  return raw & 0xffff;
}

export function rawWordToEngineering(def: SignalDef, word: number): number {
  const { range, rawRange } = requireRawDef(def);
  const [emin, emax] = range;
  const [rmin, rmax] = rawRange;
  const signedRaw = unsignedWordToSignedIfNeeded(word, rawRange);
  const ratio = (signedRaw - rmin) / (rmax - rmin);
  return emin + ratio * (emax - emin);
}

export function engineeringToRawWord(def: SignalDef, value: number): number {
  const { range, rawRange } = requireRawDef(def);
  const [emin, emax] = range;
  const [rmin, rmax] = rawRange;
  const ratio = (value - emin) / (emax - emin);
  const raw = Math.round(rmin + ratio * (rmax - rmin));
  const clamped = Math.min(rmax, Math.max(rmin, raw));
  return signedToUnsignedWord(clamped);
}
