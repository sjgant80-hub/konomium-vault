// konomium-vault · node.mjs — the sovereign accounting node (d=4, the organism)
// One object that wires vault + ingest + sync + mtd into a single surface.
// Open it with a seed. Feed it CSVs. Compute VAT. Sync with a peer. Export.
// Zero dependencies. Runs in browser or Node >= 20.

import { Vault, memoryAdapter, VAULT_FORMAT } from './vault.mjs';
import { ingest, ingestToVault, parseCSV, detectFormat } from './ingest.mjs';
import { generateHandshake, parseHandshake, createSyncSession } from './sync.mjs';
import { computeVATReturn, formatForHMRC, prepareSubmission, VAT_RATES } from './mtd.mjs';

export class KonomiumNode {
  constructor(opts = {}) {
    this.vault = new Vault(opts);
    this.adapter = opts.adapter || null;
    this._opened = false;
  }

  async open(masterSeed) {
    await this.vault.open(masterSeed);
    this._opened = true;
    return this;
  }

  get opened() { return this._opened; }

  #assert() {
    if (!this._opened) throw new Error('node is not open — call open(masterSeed) first');
  }

  async ingestCSV(csvText, batchId) {
    this.#assert();
    return ingestToVault(this.vault, csvText, batchId);
  }

  previewCSV(csvText) {
    return ingest(csvText);
  }

  async vatReturn(period) {
    this.#assert();
    return prepareSubmission(this.vault, period);
  }

  initiateSync() {
    this.#assert();
    const handshake = generateHandshake();
    return {
      token: handshake.token,
      connect: () => createSyncSession(handshake, this.vault),
    };
  }

  async joinSync(token) {
    this.#assert();
    return createSyncSession(token, this.vault);
  }

  async export() {
    this.#assert();
    return this.vault.export();
  }

  static async import(blob, masterSeed, opts = {}) {
    const vault = await Vault.import(blob, masterSeed, opts);
    const node = new KonomiumNode(opts);
    node.vault = vault;
    node._opened = true;
    return node;
  }

  async put(id, value) { this.#assert(); return this.vault.put(id, value); }
  async get(id) { this.#assert(); return this.vault.get(id); }
  async erase(id) { this.#assert(); return this.vault.erase(id); }
  async purge() { await this.vault.purge(); this._opened = false; }
  async keys() { this.#assert(); return this.vault.keys(); }

  async summary() {
    this.#assert();
    const allKeys = await this.vault.keys();
    const txKeys = allKeys.filter(k => k.startsWith('tx-'));
    const manifestKeys = allKeys.filter(k => k.startsWith('manifest-'));
    return {
      totalRecords: allKeys.length,
      transactions: txKeys.length,
      batches: manifestKeys.length,
      otherRecords: allKeys.length - txKeys.length - manifestKeys.length,
    };
  }
}

export { Vault, memoryAdapter, VAULT_FORMAT };
export { ingest, parseCSV, detectFormat };
export { generateHandshake, parseHandshake };
export { computeVATReturn, formatForHMRC, VAT_RATES };
export default KonomiumNode;
