'use strict';

// In-memory entity store, seeded deterministically from fixtures/generator.js.
// This stands in for the ERP's database: the pdf-service NEVER reads it —
// clients (trigger script / Django) read entities here and submit them to
// POST /jobs, where they are snapshotted. Mutations via PUT after that point
// must not affect in-flight renders (the stale-data proof exercises exactly this).

class EntityStore {
  constructor() {
    this.collections = new Map(); // kind -> Map(id -> entity)
  }

  collection(kind) {
    if (!this.collections.has(kind)) this.collections.set(kind, new Map());
    return this.collections.get(kind);
  }

  seed(kind, entities) {
    const col = this.collection(kind);
    col.clear();
    for (const e of entities) col.set(e.id, e);
    return col.size;
  }

  list(kind, { offset = 0, limit = 50 } = {}) {
    const all = [...this.collection(kind).values()];
    return { items: all.slice(offset, offset + limit), total: all.length, offset, limit };
  }

  get(kind, id) {
    return this.collection(kind).get(id) || null;
  }

  create(kind, entity) {
    const col = this.collection(kind);
    if (!entity.id) throw Object.assign(new Error('id is required'), { status: 400 });
    if (col.has(entity.id)) throw Object.assign(new Error('id already exists'), { status: 409 });
    const stored = { ...entity, updatedAt: new Date().toISOString() };
    col.set(entity.id, stored);
    return stored;
  }

  // Mutation endpoint semantics: shallow-merge the patch onto the entity,
  // id immutable, updatedAt bumped.
  update(kind, id, patch) {
    const col = this.collection(kind);
    const existing = col.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...patch, id, updatedAt: new Date().toISOString() };
    col.set(id, updated);
    return updated;
  }

  remove(kind, id) {
    return this.collection(kind).delete(id);
  }
}

module.exports = { EntityStore };
