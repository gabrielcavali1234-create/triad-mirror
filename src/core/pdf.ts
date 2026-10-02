// ══════════════════════════════════════════════════════════════════════════
// Leitura e recorte de PDF — herdado da TRIAD sem mudança de lógica.
// Inclui a descriptografia manual RC4 para PDFs com "proteção falsa"
// (restrição de permissão sem senha real), comum em extratos e faturas.
// ══════════════════════════════════════════════════════════════════════════
import crypto from 'crypto';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

export const MAX_PDF_PAGES_PER_CALL = 5;
export const MAX_PDF_BYTES_PER_CALL = 10 * 1024 * 1024;

export class PdfPasswordError extends Error {
    code: 'PDF_PASSWORD_REQUIRED' | 'PDF_PASSWORD_INCORRECT';
    constructor(code: 'PDF_PASSWORD_REQUIRED' | 'PDF_PASSWORD_INCORRECT', message: string) {
        super(message);
        this.code = code;
    }
}

const PDF_PAD_BYTES = Buffer.from([
    0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56, 0xFF, 0xFA, 0x01, 0x08,
    0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80, 0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A
]);

function rc4(key: Buffer, data: Buffer): Buffer {
    const S = new Uint8Array(256);
    for (let i = 0; i < 256; i++) S[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + S[i] + key[i % key.length]) & 0xff;
        [S[i], S[j]] = [S[j], S[i]];
    }
    const out = Buffer.alloc(data.length);
    let i = 0; j = 0;
    for (let k = 0; k < data.length; k++) {
        i = (i + 1) & 0xff;
        j = (j + S[i]) & 0xff;
        [S[i], S[j]] = [S[j], S[i]];
        out[k] = data[k] ^ S[(S[i] + S[j]) & 0xff];
    }
    return out;
}

function computarChaveDocumentoPdf(oEntry: Buffer, pValue: number, idEntry: Buffer, keyLengthBytes: number, revisao: number): Buffer {
    const input = Buffer.concat([PDF_PAD_BYTES, oEntry, Buffer.from([
        pValue & 0xff, (pValue >> 8) & 0xff, (pValue >> 16) & 0xff, (pValue >> 24) & 0xff
    ]), idEntry]);
    let hash = crypto.createHash('md5').update(input).digest();
    if (revisao >= 3) {
        for (let i = 0; i < 50; i++) {
            hash = crypto.createHash('md5').update(hash.subarray(0, keyLengthBytes)).digest();
        }
    }
    return hash.subarray(0, keyLengthBytes);
}

function chaveDoObjetoPdf(chaveBase: Buffer, numeroObjeto: number, geracao: number): Buffer {
    const extra = Buffer.from([
        numeroObjeto & 0xff, (numeroObjeto >> 8) & 0xff, (numeroObjeto >> 16) & 0xff,
        geracao & 0xff, (geracao >> 8) & 0xff
    ]);
    const hash = crypto.createHash('md5').update(Buffer.concat([chaveBase, extra])).digest();
    return hash.subarray(0, Math.min(chaveBase.length + 5, 16));
}

function descriptografarPdfRC4(pdfDoc: PDFDocument): PDFDocument {
    const ctx = pdfDoc.context;
    const encryptRef = ctx.trailerInfo.Encrypt;
    if (!encryptRef) return pdfDoc;

    const encryptDict: any = ctx.lookup(encryptRef);
    const filtro = encryptDict.get(PDFName.of('Filter'))?.toString();
    const v = encryptDict.get(PDFName.of('V'))?.asNumber() ?? 0;

    if (filtro !== '/Standard' || (v !== 1 && v !== 2)) {
        throw new Error(`Esquema de criptografia não suportado pela descriptografia manual (Filter=${filtro}, V=${v}).`);
    }

    const oEntry = Buffer.from(encryptDict.get(PDFName.of('O')).asBytes());
    const pValue = encryptDict.get(PDFName.of('P')).asNumber();
    const rValue = encryptDict.get(PDFName.of('R')).asNumber();
    const lengthBits = encryptDict.get(PDFName.of('Length'))?.asNumber() || 40;
    const keyLengthBytes = lengthBits / 8;

    const idArray: any = ctx.trailerInfo.ID;
    if (!idArray || !idArray.array || !idArray.array[0]) {
        throw new Error('Documento sem /ID no trailer — não é possível derivar a chave de descriptografia.');
    }
    const idEntry = Buffer.from(idArray.array[0].asBytes());
    const chaveBase = computarChaveDocumentoPdf(oEntry, pValue, idEntry, keyLengthBytes, rValue);

    for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
        if (obj instanceof PDFRawStream) {
            const chaveObj = chaveDoObjetoPdf(chaveBase, ref.objectNumber, ref.generationNumber);
            (obj as any).contents = rc4(chaveObj, Buffer.from((obj as any).contents));
        }
    }

    delete (ctx.trailerInfo as any).Encrypt;
    return pdfDoc;
}

/** Retorna null quando o PDF não pode ser recortado (aí ele é enviado inteiro). */
export async function splitPdfIntoChunks(fileBuffer: Buffer, password?: string): Promise<{ chunks: string[]; pageCount: number } | null> {
    let pdfDoc: PDFDocument;
    let bufferDescriptografado: Buffer | null = null;

    try {
        pdfDoc = await PDFDocument.load(fileBuffer);
    } catch (pdfError: any) {
        const pareceProtegido = /encrypted/i.test(pdfError?.message || '') || pdfError?.name === 'EncryptedPDFError';

        if (!pareceProtegido) {
            try {
                pdfDoc = await PDFDocument.load(fileBuffer, {
                    ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false
                } as any);
                console.log('[PDF] Carregado só com leitura flexível — seguindo com o recorte normal.');
            } catch {
                console.error('[PDF] Falha ao carregar PDF (mesmo com leitura flexível):', pdfError.message);
                return null;
            }
        } else {
            try {
                const pdfSemProtecao = await PDFDocument.load(fileBuffer, { ignoreEncryption: true } as any);
                try {
                    pdfDoc = descriptografarPdfRC4(pdfSemProtecao);
                    console.log('[PDF] Restrição de permissão (sem senha real) — descriptografado (RC4).');
                } catch (decryptError: any) {
                    console.log(`[PDF] Não foi possível descriptografar (${decryptError.message}) — enviando inteiro.`);
                    return null;
                }
            } catch {
                if (!password) {
                    throw new PdfPasswordError('PDF_PASSWORD_REQUIRED', 'Este PDF está protegido por senha. Informe a senha para continuar.');
                }
                try {
                    pdfDoc = await PDFDocument.load(fileBuffer, { password, ignoreEncryption: true } as any);
                } catch {
                    throw new PdfPasswordError('PDF_PASSWORD_INCORRECT', 'Senha incorreta para este PDF.');
                }
                bufferDescriptografado = Buffer.from(await pdfDoc.save());
                console.log('[PDF] Descriptografado com a senha fornecida.');
            }
        }
    }

    const bufferFinal = bufferDescriptografado || fileBuffer;
    const pageCount = pdfDoc.getPageCount();

    if (pageCount <= MAX_PDF_PAGES_PER_CALL && bufferFinal.length <= MAX_PDF_BYTES_PER_CALL) {
        return { chunks: [bufferFinal.toString('base64')], pageCount };
    }

    const chunks: string[] = [];
    for (let i = 0; i < pageCount; i += MAX_PDF_PAGES_PER_CALL) {
        const newPdf = await PDFDocument.create();
        const end = Math.min(i + MAX_PDF_PAGES_PER_CALL, pageCount);
        const copiedPages = await newPdf.copyPages(pdfDoc, Array.from({ length: end - i }, (_, k) => i + k));
        copiedPages.forEach(page => newPdf.addPage(page));
        chunks.push(Buffer.from(await newPdf.save()).toString('base64'));
    }

    console.log(`[PDF] ${pageCount} páginas divididas em ${chunks.length} parte(s).`);
    return { chunks, pageCount };
}
