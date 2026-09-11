import { createHash } from 'node:crypto';
import { canonicalJson } from './receipt.mjs';

const GENESIS = '0'.repeat(64);

export class ReceiptChain {
  #entries = [];

  append(receipt) {
    if (receipt?.schema !== 'road-connector-receipt-v1') throw new TypeError('valid connector receipt required');
    const sequence = this.#entries.length;
    const previousHash = sequence === 0 ? GENESIS : this.#entries[sequence - 1].hash;
    const hash = entryHash(sequence, previousHash, receipt);
    const entry = Object.freeze({ sequence, previousHash, receipt, hash });
    this.#entries.push(entry);
    return entry;
  }

  entries() {
    return [...this.#entries];
  }

  checkpoint() {
    return Object.freeze({
      length: this.#entries.length,
      head: this.#entries.length === 0 ? GENESIS : this.#entries[this.#entries.length - 1].hash
    });
  }

  verify(entries = this.#entries, checkpoint = null) {
    let previousHash = GENESIS;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.sequence !== index || entry.previousHash !== previousHash || entry.hash !== entryHash(index, previousHash, entry.receipt)) {
        return { valid: false, length: entries.length, errorAt: index };
      }
      previousHash = entry.hash;
    }
    if (checkpoint && (checkpoint.length !== entries.length || checkpoint.head !== previousHash)) {
      return { valid: false, length: entries.length, errorAt: entries.length, reason: 'checkpoint-mismatch' };
    }
    return { valid: true, length: entries.length, head: previousHash };
  }
}

function entryHash(sequence, previousHash, receipt) {
  return createHash('sha256').update(`${sequence}:${previousHash}:${canonicalJson(receipt)}`).digest('hex');
}
