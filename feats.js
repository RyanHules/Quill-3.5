// D&D 3.5 Character Sheet - Feats & Abilities Module

const Feats = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // ---- Structured feat entries -----------------------------------------
  // A feat row whose name resolves to a real DB feat renders as a read-only
  // INFO BOX (name display + a specialization control for choice feats like
  // Skill Focus); homebrew / non-DB names stay editable text. The canonical
  // value still lives in a (hidden, for structured rows) `.feat-entry`
  // textarea — "Skill Focus (Diplomacy)" — so collectData /
  // getResolvedFeatBonuses / the ⓘ + prereq tooling keep reading it
  // unchanged, and the save format is untouched. Auto-detected on add/load.
  let _featInfoMap = null;   // lowername → { specialization|null }
  function featInfoMap() {
    if (_featInfoMap) return _featInfoMap;
    const m = new Map();
    if (window.DB && DB.isLoaded()) {
      for (const r of DB.query(
        "SELECT name, json_extract(data,'$.specialization') AS spec "
        + "FROM entry WHERE type='feat'")) {
        const key = String(r.name).toLowerCase();
        const existing = m.get(key);
        // Multiple printings of a same-named feat collapse to one map slot.
        // Prefer a printing that carries a specialization marker — printings
        // can diverge (e.g. the FRCS Greater Spell Focus lives in the bare
        // `feats/` folder that normalize_schema's by-name stamp skips), and
        // without this the unmarked row could win the slot and suppress the
        // spec control.
        if (existing && existing.specialization) continue;
        m.set(key, { specialization: r.spec || null });
      }
      _featInfoMap = m;   // cache only once the DB is loaded
    }
    return m;
  }
  function parseFeatText(text) {
    const m = String(text || "").trim()
      .match(/^([^(]+?)\s*(?:\(([^)]*)\))?\s*$/);
    return m ? { name: m[1].trim(), spec: (m[2] || "").trim() }
             : { name: String(text || "").trim(), spec: "" };
  }
  function lookupFeatInfo(name) {
    return featInfoMap().get(String(name || "").toLowerCase()) || null;
  }
  // Closed-list options for the specialization control, by kind. `weapon`
  // is intentionally absent — too many weapons to enumerate, so it stays a
  // plain free-text input. `skill` pulls the live skill list from data.js.
  const SPEC_SCHOOLS = ["Abjuration", "Conjuration", "Divination",
    "Enchantment", "Evocation", "Illusion", "Necromancy", "Transmutation"];
  const SPEC_ENERGY = ["Acid", "Cold", "Electricity", "Fire", "Sonic"];
  function specDatalistOptions(kind) {
    if (kind === "skill") {
      return (typeof DND35 !== "undefined" && Array.isArray(DND35.skills))
        ? DND35.skills.map(s => typeof s === "string" ? s : (s && s.name))
            .filter(Boolean)
        : [];
    }
    if (kind === "school") return SPEC_SCHOOLS;
    if (kind === "energy") return SPEC_ENERGY;
    return null;   // weapon / unknown → free text, no datalist
  }
  // Build (once) a datalist for a closed-list spec kind; returns its id, or
  // null for free-text kinds. id is stable per kind so rows share one list.
  function ensureSpecDatalist(kind) {
    const opts = specDatalistOptions(kind);
    if (!opts || !opts.length) return null;
    const id = `feat-spec-list-${kind}`;
    if (document.getElementById(id)) return id;
    const dl = document.createElement("datalist");
    dl.id = id;
    for (const name of opts) {
      const o = document.createElement("option");
      o.value = name;   // NO label attr (Firefox datalist label bug, see CLAUDE.md)
      dl.appendChild(o);
    }
    document.body.appendChild(dl);
    return id;
  }

  // text: the feat string ("Iron Will", "Skill Focus (Diplomacy)").
  // opts.sourceLabel: marks a DERIVED bonus-feat row (bloodline / class
  // grant). The row renders read-only like a picker-added feat, but shows
  // the granting source as a read-only tag instead of an editable spec
  // control (the annotation is a source label, not a specialization), and
  // it stays structured even when the feat isn't a DB match.
  // opts.replaceRow: an existing `.feat-row` to swap out in place instead
  // of appending. The feat-picker uses this when it fills a blank row —
  // writing the name straight into that row's textarea left it as a plain
  // editable box, so a picker-added feat looked and behaved differently
  // depending on whether a blank row happened to exist (report
  // rms23xqqq-c0yf). Rebuilding the row keeps its POSITION in the list.
  function addFeat(text = "", opts = {}) {
    const container = $("#feats-container");
    const div = document.createElement("div");
    div.className = "feat-row";
    // Granting level for an auto-added BONUS feat (class/bloodline/…). Lets the
    // Build Timeline place it at its real level instead of the generic feat
    // schedule (report rmso7oje3). Absent on player-chosen feats.
    if (opts.featLevel != null) div.dataset.featLevel = String(opts.featLevel);
    const ta = document.createElement("textarea");
    ta.className = "feat-entry";
    ta.placeholder = "Feat name & details";
    ta.rows = 1;
    ta.value = text;

    const sourceLabel = opts.sourceLabel || null;
    const parsed = parseFeatText(text);
    const dbInfo = lookupFeatInfo(parsed.name);

    // ⓘ button — collapsible rules panel from the DB (or graceful fallback).
    const info = document.createElement("button");
    info.type = "button";
    info.className = "btn-feat-info";
    info.title = "Show rules text";
    info.setAttribute("aria-expanded", "false");
    info.textContent = "ⓘ";
    info.addEventListener("click", () => toggleFeatRules(div));
    // Prereq audit badge (·/✓/✗/?), click to expand the breakdown.
    const prereq = document.createElement("button");
    prereq.type = "button";
    prereq.className = "btn-feat-prereq";
    prereq.title = "Prerequisite check (click for breakdown)";
    prereq.textContent = "·";
    prereq.addEventListener("click", () => toggleFeatPrereqDetail(div));
    const btn = document.createElement("button");
    btn.className = "btn-remove";
    btn.textContent = "X";
    btn.addEventListener("click", () => div.remove());
    // Collapse the rules panel + refresh the prereq badge whenever the
    // canonical value changes (a free-text edit, or a structured spec
    // change which writes back to .feat-entry).
    ta.addEventListener("input", () => {
      collapseFeatRules(div);
      refreshFeatPrereqBadge(div);
    });

    if (dbInfo || sourceLabel) {
      // Structured info box: hidden canonical .feat-entry + name display.
      // Either an auto-detected DB feat OR a derived grant (which renders
      // structured even when it isn't a DB match).
      div.classList.add("feat-structured");
      ta.style.display = "none";
      div.appendChild(ta);
      const box = document.createElement("div");
      box.className = "feat-namebox";
      const nameEl = document.createElement("span");
      nameEl.className = "feat-name-display";
      nameEl.textContent = parsed.name;
      box.appendChild(nameEl);
      if (sourceLabel) {
        // Derived row: read-only source tag (the granting bloodline / class),
        // NOT an editable spec control — the annotation isn't a specialization.
        div.classList.add("feat-derived");
        const tag = document.createElement("span");
        tag.className = "feat-source-tag";
        tag.textContent = sourceLabel;
        box.appendChild(tag);
      } else {
        // Render the specialization control when the feat is MARKED as a
        // choice feat (DB `specialization`), OR — safety net — when the
        // canonical text already carries a parenthetical even though the feat
        // isn't marked. Without the latter, a structured feat added as
        // "Foo (Bar)" would hide "(Bar)" with no way to see/edit it (the read-
        // only dead-end Ryan flagged). Unmarked → free-text kind.
        const specKind = dbInfo.specialization || (parsed.spec ? "detail" : null);
        if (specKind) {
          box.appendChild(document.createTextNode(" ("));
          const spec = document.createElement("input");
          spec.className = "feat-spec";
          spec.value = parsed.spec || "";
          spec.placeholder = "choose…";
          spec.size = 14;
          spec.title = `Specialization (${specKind})`;
          const listId = ensureSpecDatalist(specKind);
          if (listId) spec.setAttribute("list", listId);
          if (!parsed.spec) box.classList.add("feat-spec-unset");
          spec.addEventListener("input", () => {
            const s = spec.value.trim();
            ta.value = s ? `${parsed.name} (${s})` : parsed.name;
            box.classList.toggle("feat-spec-unset", !s);
            // Refresh the row's own tooling; recalc fires from this event
            // bubbling to the document-level input listener.
            collapseFeatRules(div);
            refreshFeatPrereqBadge(div);
          });
          box.appendChild(spec);
          box.appendChild(document.createTextNode(")"));
        }
      }
      div.appendChild(box);
    } else {
      div.appendChild(ta);
    }
    div.appendChild(info);
    div.appendChild(prereq);
    div.appendChild(btn);
    const target = opts.replaceRow;
    if (target && target.parentNode) target.replaceWith(div);
    else container.appendChild(div);
    refreshFeatPrereqBadge(div);
    return div;
  }

  // Look up the row's feat name in the DB, parse + check prereqs,
  // and update the prereq badge (·/✓/✗/?) + tooltip. Cheap; called
  // on every input event and on global character-state changes.
  function refreshFeatPrereqBadge(row) {
    const ta = row.querySelector(".feat-entry");
    const badge = row.querySelector(".btn-feat-prereq");
    if (!ta || !badge) return;
    const raw = (ta.value || "").trim();
    const firstLine = raw.split(/\r?\n/)[0].trim();
    const name = firstLine.replace(/\s*\([^)]*\)\s*$/, "").trim();
    badge.dataset.status = "neutral";
    badge.textContent = "·";
    badge.title = "Prerequisite check";
    if (!name || !(window.DB && DB.isLoaded()) ||
        typeof FeatPrereqs === 'undefined') return;
    const row2 = DB.queryOne(
      "SELECT json_extract(data, '$.prerequisites') AS p " +
      "FROM entry WHERE type='feat' AND name = :n COLLATE NOCASE LIMIT 1",
      { ":n": name });
    if (!row2 || !row2.p || !row2.p.trim() ||
        row2.p === "-" || /^none$/i.test(row2.p)) {
      badge.dataset.status = "none";
      badge.textContent = "—";
      badge.title = "No prerequisites";
      return;
    }
    const ev = FeatPrereqs.evaluate(row2.p);
    badge.dataset.status = ev.summary.status;
    badge.textContent = ev.summary.label;
    badge.title = `Prereq: ${row2.p}\n` +
      ev.atoms.map(a =>
        `  ${a.status === 'satisfied' ? '✓' : a.status === 'unmet' ? '✗' : '?'} ${a.raw}${a.detail ? ` — ${a.detail}` : ''}`
      ).join('\n');
  }

  function toggleFeatPrereqDetail(row) {
    const existing = row.querySelector(".feat-prereq-detail");
    if (existing) { existing.remove(); return; }
    const ta = row.querySelector(".feat-entry");
    const raw = (ta?.value || "").trim();
    const firstLine = raw.split(/\r?\n/)[0].trim();
    const name = firstLine.replace(/\s*\([^)]*\)\s*$/, "").trim();
    if (!name || !(window.DB && DB.isLoaded()) ||
        typeof FeatPrereqs === 'undefined') return;
    const r = DB.queryOne(
      "SELECT json_extract(data, '$.prerequisites') AS p " +
      "FROM entry WHERE type='feat' AND name = :n COLLATE NOCASE LIMIT 1",
      { ":n": name });
    const detail = document.createElement("div");
    detail.className = "feat-prereq-detail";
    if (!r || !r.p || !r.p.trim() || r.p === "-" || /^none$/i.test(r.p)) {
      detail.innerHTML = '<i style="opacity:.7">No prerequisites.</i>';
    } else {
      const ev = FeatPrereqs.evaluate(r.p);
      detail.innerHTML =
        `<b>Prereq:</b> ${r.p.replace(/[<>&]/g, c =>
          ({'<':'&lt;','>':'&gt;','&':'&amp;'})[c])}<br>` +
        `<span class="fp-atoms">${ev.html}</span>`;
    }
    row.appendChild(detail);
  }

  // Refresh every row's prereq badge — called on global state changes
  // (ability scores edited, classes applied, other feats added, etc.).
  function refreshAllPrereqBadges() {
    document.querySelectorAll("#feats-container .feat-row")
      .forEach(refreshFeatPrereqBadge);
  }
  // Wire the global hook on first module evaluation.
  document.addEventListener("audit-refresh", refreshAllPrereqBadges);

  function toggleFeatRules(row) {
    const existing = row.querySelector(".feat-rules");
    if (existing) {
      collapseFeatRules(row);
      return;
    }
    const ta = row.querySelector(".feat-entry");
    const btn = row.querySelector(".btn-feat-info");
    const name = (ta.value || "").trim();
    const panel = document.createElement("div");
    panel.className = "feat-rules";
    if (!name) {
      panel.innerHTML = '<i style="opacity:.7">Type a feat name first.</i>';
    } else if (!(window.DB && DB.isLoaded())) {
      panel.innerHTML = '<i style="opacity:.7">Database not loaded — rules text unavailable.</i>';
    } else {
      const rendered = renderFeatRules(name);
      panel.innerHTML = rendered.html;
      // Tack on the errata badge (advisory + applied) when the lookup
      // resolved to a real entry.
      if (rendered.entryId && window.ErrataBadge) {
        ErrataBadge.attach(panel, rendered.entryId);
      }
    }
    row.appendChild(panel);
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("active");
  }

  function collapseFeatRules(row) {
    const panel = row.querySelector(".feat-rules");
    if (panel) panel.remove();
    const btn = row.querySelector(".btn-feat-info");
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("active");
    }
  }

  // Look up a feat by typed name (case-insensitive). Returns rendered
  // HTML for the rules panel. Tries the typed name as a whole-string
  // match first; if that fails (e.g. the user typed "Power Attack
  // (Str 17)"), tries a prefix match on the leading word group.
  function renderFeatRules(name) {
    const TYPES = "('feat','acf','skill_trick')";
    // Whole-string match. Latest version wins (3.5 > 3.0).
    let row = DB.queryOne(
      "SELECT e.id, e.name, e.version, e.source, e.types_csv, " +
      "  json_extract(e.data, '$.prerequisites') AS prerequisites, " +
      "  json_extract(e.data, '$.benefit')       AS benefit, " +
      "  json_extract(e.data, '$.normal')        AS normal, " +
      "  json_extract(e.data, '$.special')       AS special, " +
      "  json_extract(e.data, '$.description')   AS description, " +
      "  json_extract(e.data, '$.tables')        AS tables_json " +
      "FROM entry e " +
      "WHERE e.type IN " + TYPES + " AND LOWER(e.name) = LOWER(?) " +
      "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
      [name]
    );
    if (!row) {
      // Strip trailing parenthetical / annotation and retry.
      const stripped = name.replace(/\s*\(.*\)\s*$/, "").trim();
      if (stripped && stripped !== name) {
        row = DB.queryOne(
          "SELECT e.id, e.name, e.version, e.source, e.types_csv, " +
          "  json_extract(e.data, '$.prerequisites') AS prerequisites, " +
          "  json_extract(e.data, '$.benefit')       AS benefit, " +
          "  json_extract(e.data, '$.normal')        AS normal, " +
          "  json_extract(e.data, '$.special')       AS special, " +
          "  json_extract(e.data, '$.description')   AS description, " +
          "  json_extract(e.data, '$.tables')        AS tables_json " +
          "FROM entry e " +
          "WHERE e.type IN " + TYPES + " AND LOWER(e.name) = LOWER(?) " +
          "ORDER BY CASE e.version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
          [stripped]
        );
      }
    }
    if (!row) {
      return {
        html: '<i style="opacity:.7">No rules text found in database — ' +
          'this looks like a homebrew or custom entry.</i>',
        entryId: null,
      };
    }
    const bits = [];
    // Title line: bold name, source attribution, VersionBadge for
    // non-3.5 (replaces the old inline "(source, 3.0)" parenthetical).
    const verBadge = (window.VersionBadge ? VersionBadge.html(row.version) : "");
    bits.push(`<b>${escapeHtml(row.name)}</b>${verBadge}` +
      ` <span style="opacity:.7">(${escapeHtml(row.source || "?")})</span>`);
    if (row.types_csv)     bits.push(`<b>Type:</b> ${escapeHtml(row.types_csv)}`);
    if (row.prerequisites) bits.push(`<b>Prereq:</b> ${escapeHtml(row.prerequisites)}`);
    if (row.benefit)       bits.push(`<b>Benefit:</b> ${escapeHtml(row.benefit)}`);
    if (row.normal)        bits.push(`<b>Normal:</b> ${escapeHtml(row.normal)}`);
    if (row.special)       bits.push(`<b>Special:</b> ${escapeHtml(row.special)}`);
    if (row.description && !row.benefit) {
      bits.push(`<b>Description:</b> ${escapeHtml(row.description)}`);
    }
    // Structured data tables (Track's DC-by-surface, Investigate's
    // three modifier tables, Draconic Heritage's kind/energy map, …)
    // — rendered as real HTML tables via the shared RichText module.
    if (row.tables_json && window.RichText) {
      try {
        const tablesHtml = RichText.renderTables(JSON.parse(row.tables_json));
        if (tablesHtml) bits.push(tablesHtml);
      } catch (e) { /* malformed tables JSON — skip silently */ }
    }
    let html = bits.join("<br>");
    // Homebrew add-on: Item Familiar campaign rules (Progressive Bond
    // Track, Augmentation Budget, Jianghu free-feat doctrine). Each
    // sub-rule is independently togglable via the HomebrewFilter UI.
    // The hook returns '' when no rule is enabled, so this is a
    // zero-cost path for the default RAW user.
    if (window.HomebrewItemFamiliar) {
      const hbHtml = HomebrewItemFamiliar.appendRulesHtml(row.name);
      if (hbHtml) html += hbHtml;
    }
    return { html, entryId: row.id };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function addSpecialAbility(text = "", fromClass = null) {
    const container = $("#special-abilities-container");
    const div = document.createElement("div");
    div.className = "feat-row";
    const ta = document.createElement("textarea");
    ta.className = "special-ability-entry";
    ta.placeholder = "Ability name & description";
    ta.rows = 1;
    ta.value = text;
    // Class-picker stamps auto-added class features with their origin class
    // so a later level-up / re-apply can dedupe its own entries. That marker
    // MUST round-trip through save/load — without it, loaded class features
    // lose the tag and the next class apply re-adds the whole cumulative set
    // on top (the "applying a class re-adds all features" duplication bug).
    if (fromClass) ta.dataset.fromClass = String(fromClass);
    // ⓘ button toggles a collapsible panel below the row showing the
    // class-feature's full rules text from the DB. Class-picker stamps
    // entries as `[ClassName Level] AbilityName` — we parse that prefix
    // to look up the matching class_features entry. Custom-typed
    // abilities (no prefix) get a "no rules text" fallback.
    const info = document.createElement("button");
    info.type = "button";
    info.className = "btn-feat-info";
    info.title = "Show rules text";
    info.setAttribute("aria-expanded", "false");
    info.textContent = "ⓘ";
    info.addEventListener("click", () => toggleAbilityRules(div));
    const btn = document.createElement("button");
    btn.className = "btn-remove";
    btn.textContent = "X";
    btn.addEventListener("click", () => div.remove());
    ta.addEventListener("input", () => collapseAbilityRules(div));
    div.appendChild(ta);
    div.appendChild(info);
    div.appendChild(btn);
    container.appendChild(div);
  }

  function toggleAbilityRules(row) {
    const existing = row.querySelector(".feat-rules");
    if (existing) {
      collapseAbilityRules(row);
      return;
    }
    const ta = row.querySelector(".special-ability-entry");
    const btn = row.querySelector(".btn-feat-info");
    const text = (ta.value || "").trim();
    const panel = document.createElement("div");
    panel.className = "feat-rules";
    if (!text) {
      panel.innerHTML = '<i style="opacity:.7">Type an ability first.</i>';
    } else if (!(window.DB && DB.isLoaded())) {
      panel.innerHTML = '<i style="opacity:.7">Database not loaded — rules text unavailable.</i>';
    } else {
      const rendered = renderAbilityRules(text);
      panel.innerHTML = rendered.html;
      // Tack on the errata badge when the lookup resolved to a real,
      // self-contained entry (skill tricks). Class features / racial
      // traits live inside their parent class/race blob, whose errata
      // doesn't map cleanly to a single sub-feature — so those return
      // a null entryId and the badge is skipped.
      if (rendered.entryId && window.ErrataBadge) {
        ErrataBadge.attach(panel, rendered.entryId);
      }
    }
    row.appendChild(panel);
    btn.setAttribute("aria-expanded", "true");
    btn.classList.add("active");
  }

  function collapseAbilityRules(row) {
    const panel = row.querySelector(".feat-rules");
    if (panel) panel.remove();
    const btn = row.querySelector(".btn-feat-info");
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.classList.remove("active");
    }
  }

  // Parse an entry like `[Wizard 5] Bonus feat` or `[Sha'ir 1] Summon
  // Gen Familiar` into { className, abilityName }. Returns null for
  // unprefixed (user-typed) entries.
  function parseAbilityPrefix(text) {
    const m = text.match(/^\[([^\]]+?)\s+\d+\]\s*(.+)$/);
    if (!m) return null;
    return { className: m[1].trim(), abilityName: m[2].trim() };
  }

  // Stem an ability label — strip trailing scaling notation that
  // changes between class levels (Smite Evil 3/day vs Smite Evil 5/day)
  // so we can match against the canonical class_features.name.
  function stemAbilityName(name) {
    return String(name || "")
      .replace(/\s*\d+\/(?:day|week|round|encounter|hour|hr|minute|min)/gi, "")
      .replace(/\s*[+\-]?\d+d\d+/g, "")
      .replace(/\s*\([^)]*\)\s*$/g, "")
      .replace(/\s+[+\-]?\d+\s*$/g, "")
      .trim()
      .toLowerCase();
  }

  // Resolve a Special Abilities row to its rules text. The list is fed
  // from several sources, each with its own text shape — so we try them
  // in order and return the first that resolves:
  //   1. Class features (class-picker)        → `[Class N] Ability Name`
  //   2. Racial traits (race-picker)          → bare trait name
  //   3. Creature abilities (creature-race-picker) → bare ability name
  //   4. Skill tricks (special-ability-picker) → `Name · category…\nbenefit`
  // Anything else is treated as a custom / homebrew entry. Returns
  // { html, entryId } so the caller can attach an errata badge when the
  // match is a self-contained DB entry (skill tricks only — see below).
  //
  // Both the racial and creature resolvers key off #char-race — the
  // single unified Race field (the separate creature input was removed
  // 2026-06-03; race-unify.js routes a typed name to the right picker).
  // #char-race persists via Character, so this works live AND after a
  // save/reload. Racial runs first because real
  // races are the common case; pure monsters (Hound Archon, Mind Flayer,
  // Troll…) aren't in the `race` table, so racial returns null and the
  // creature resolver takes over. A few names exist as BOTH a race and an
  // as_character creature (Kobold/Orc/Goblin/Lizardfolk); for those the
  // race trait wins on overlapping ability names — acceptable, since the
  // text is near-identical and non-overlapping creature abilities still
  // resolve via the creature resolver.
  function renderAbilityRules(text) {
    // 1. Class-prefixed class feature.
    const parsed = parseAbilityPrefix(text);
    if (parsed) return renderClassFeatureRules(parsed);
    // 2. Racial trait — scoped to the character's current race so a
    //    trait name can't false-match a same-named entry elsewhere.
    const racial = renderRacialTraitRules(text);
    if (racial) return racial;
    // 3. Creature-as-race ability (creature name in #char-race).
    const creature = renderCreatureAbilityRules(text);
    if (creature) return creature;
    // 4. Skill trick (a real, self-contained `entry` row).
    const trick = renderSkillTrickRules(text);
    if (trick) return trick;
    // 5. Fallback for custom / homebrew abilities with no DB match.
    return {
      html: '<i style="opacity:.7">No rules text found in database — this ' +
        'looks like a custom or homebrew ability. (Class features, racial ' +
        'traits, creature abilities, and skill tricks resolve ' +
        'automatically.)</i>',
      entryId: null,
    };
  }

  // Normalize an ability label for fuzzy name matching: lowercase, drop
  // parentheticals (save-DC notes etc.), reduce punctuation to spaces,
  // collapse whitespace. "Aura of menace (Will DC 15…)" and the detail
  // block's "Aura of Menace" both normalize to "aura of menace".
  function normAbility(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function renderClassFeatureRules({ className, abilityName }) {
    const row = DB.queryOne(
      "SELECT name, source, version, " +
      "  json_extract(data, '$.class_features') AS f " +
      "FROM entry WHERE type IN ('class','prc') AND name = ? " +
      "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
      [className]
    );
    if (!row || !row.f) {
      return {
        html: `<i style="opacity:.7">Class "${escapeHtml(className)}" not ` +
          `found in database.</i>`,
        entryId: null,
      };
    }
    let features = [];
    try { features = JSON.parse(row.f) || []; } catch (e) {}
    const targetStem = stemAbilityName(abilityName);
    // Try exact name match first; fall back to stem-against-stem.
    let feat = features.find(f => (f.name || "").toLowerCase() === abilityName.toLowerCase());
    if (!feat) feat = features.find(f => stemAbilityName(f.name) === targetStem);
    if (!feat) {
      return {
        html: `<i style="opacity:.7">No matching feature ` +
          `"${escapeHtml(abilityName)}" found in ${escapeHtml(className)}'s ` +
          `class_features.</i>`,
        entryId: null,
      };
    }
    const verBadge = (window.VersionBadge ? VersionBadge.html(row.version) : "");
    const bits = [];
    bits.push(`<b>${escapeHtml(feat.name || abilityName)}</b>${verBadge}` +
      ` <span style="opacity:.7">(${escapeHtml(row.name)}` +
      (feat.level_acquired ? ` ${feat.level_acquired}` : "") +
      `)</span>`);
    // Prefer raw_text (verbatim corpus) over description (old
    // summary) — same divergence the lookup modal fixed after the
    // Wilder Wild Surge case (2026-05-25): description can be a
    // 200-char summary while the full mechanics sit in raw_text.
    // RichText.formatFeatureText keeps the longer verbatim readable
    // (<br> structure, sub-heading bolding, 3000+ char auto-collapse).
    const body = feat.raw_text || feat.description;
    if (body) {
      bits.push(window.RichText
        ? RichText.formatFeatureText(body) : escapeHtml(body));
    }
    // Class features live inside the class blob — their errata doesn't
    // map to a single feature, so no badge (entryId: null).
    return { html: bits.join("<br>"), entryId: null };
  }

  // Resolve a racial-trait row against the character's CURRENT race
  // (read from #char-race). The race-picker auto-fills rows as
  // `Trait Name: description` (or bare `Trait Name` when the trait has
  // no description), so we recover the name as the text up to the first
  // ": " and match it exactly against the race's `traits` list. Scoping
  // to the chosen race avoids false matches and survives save/reload
  // (the race input persists; the data-from-race marker does not).
  // Returns null when there's no current race or no matching trait, so
  // the dispatcher can fall through to the next resolver.
  function renderRacialTraitRules(text) {
    const raceInput = document.getElementById("char-race");
    const raceName = (raceInput && raceInput.value || "").trim()
      .replace(/\s*\(3\.0\)\s*$/, "")
      .replace(/\s*\(3\.5\)\s*$/, "");
    if (!raceName) return null;
    const row = DB.queryOne(
      "SELECT name, source, version, " +
      "  json_extract(data, '$.traits') AS t, " +
      "  json_extract(data, '$.variant_of') AS variant_of " +
      "FROM entry WHERE type='race' AND name = ? COLLATE NOCASE " +
      "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
      [raceName]
    );
    if (!row || !row.t) return null;
    let traits = [];
    try { traits = JSON.parse(row.t) || []; } catch (e) { return null; }
    if (!Array.isArray(traits) || !traits.length) return null;
    // Recover the trait name: first line, up to the first ": " separator.
    const firstLine = text.split(/\r?\n/)[0];
    const candidate = firstLine.split(/:\s/)[0].trim().toLowerCase();
    if (!candidate) return null;
    let trait = traits.find(
      t => (t && t.name || "").trim().toLowerCase() === candidate
    );
    // Label the trait by the race that actually owns it — for an
    // environmental variant (Arctic Kobold, …) the row may be one of the
    // BASE race's traits that race-picker folded in at pick time, which
    // won't be in the variant's own `traits` list.
    let sourceRaceName = row.name;
    if (!trait) {
      // Prefer the explicit `variant_of` link; else reuse race-picker's
      // pointer-trait derivation (single source of truth) so the two can't
      // drift. Skip the base fallback gracefully if neither is present.
      const baseName = (row.variant_of && String(row.variant_of).trim())
        || ((window.RacePicker && RacePicker.variantBaseName)
          ? RacePicker.variantBaseName(traits) : null);
      if (baseName) {
        const brow = DB.queryOne(
          "SELECT name, json_extract(data, '$.traits') AS t " +
          "FROM entry WHERE type='race' AND name = ? COLLATE NOCASE " +
          "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
          [baseName]
        );
        let bt = [];
        if (brow && brow.t) { try { bt = JSON.parse(brow.t) || []; } catch (e) {} }
        const bm = bt.find(
          t => (t && t.name || "").trim().toLowerCase() === candidate
        );
        if (bm) { trait = bm; sourceRaceName = brow.name; }
      }
    }
    if (!trait) return null;
    const tag = (trait.tag || "").trim();
    const tagHtml = tag
      ? ` <span style="opacity:.7">[${escapeHtml(tag)}]</span>` : "";
    const verBadge = (window.VersionBadge ? VersionBadge.html(row.version) : "");
    const bits = [];
    bits.push(`<b>${escapeHtml(trait.name)}</b>${tagHtml}${verBadge}` +
      ` <span style="opacity:.7">(${escapeHtml(sourceRaceName)} racial trait)</span>`);
    if (trait.description && trait.description.trim()) {
      bits.push(escapeHtml(trait.description));
    } else {
      bits.push('<i style="opacity:.6">Racial trait — see the race info ' +
        'panel on the Character tab for full details.</i>');
    }
    // Racial traits live inside the race blob; race-level errata doesn't
    // map to a single trait, so no badge here (it's surfaced on the
    // Character-tab race info panel instead).
    return { html: bits.join("<br>"), entryId: null };
  }

  // Resolve a creature-as-race ability row. The creature-race-picker
  // auto-fills the creature's special attacks + qualities as bare,
  // name-only rows (e.g. "Aura of menace (Will DC 15…)", "Heat shimmer",
  // "DR 10/evil"), tagged data-from-creature-race, and writes the
  // creature's name into #char-race (the canonical Race field). We scope
  // to that creature — #char-race persists via Character, so this works
  // live AND after a save/reload — and resolve in two tiers:
  //   - Full rules: the creature's structured `special_abilities` block
  //     ({name, kind, description}) — only ~13 pickable creatures carry
  //     it, but it's the high-value case.
  //   - Honest stub: the row IS one of the creature's listed special
  //     attacks/qualities but has no detail block (passive immunities,
  //     DR/SR, or creatures whose mechanical text wasn't extracted).
  //     We say so plainly rather than letting it hit the misleading
  //     "custom or homebrew" fallback.
  // Returns null when #char-race isn't an as_character creature or the
  // row isn't one of its abilities, so the dispatcher can fall through.
  // Parse a "{Subtype} Traits" rule (Archon Traits, Baatezu Traits, …) into
  // {name, kind, description} entries. Format is an intro paragraph followed
  // by em-dash–prefixed lines: "—Aura of Menace (Su): A righteous aura …" or
  // bare descriptive lines ("—Immunity to electricity and petrification.").
  function parseSubtypeTraits(desc) {
    const out = [];
    if (!desc) return out;
    const segs = String(desc).split(/\n\s*—\s*/).slice(1); // drop intro before first entry
    for (const seg of segs) {
      const s = seg.trim();
      if (!s) continue;
      let m = s.match(/^(.+?)\s*\(([^)]+)\)\s*:\s*([\s\S]+)$/);
      if (m) { out.push({ name: m[1].trim(), kind: m[2].trim(), description: m[3].trim() }); continue; }
      m = s.match(/^(.+?)\s*:\s*([\s\S]+)$/);
      if (m) { out.push({ name: m[1].trim(), kind: "", description: m[2].trim() }); continue; }
      out.push({ name: s.split(/[.,]/)[0].trim(), kind: "", description: s }); // bare line
    }
    return out;
  }

  function renderCreatureAbilityRules(text) {
    const raceInput = document.getElementById("char-race");
    const crName = (raceInput && raceInput.value || "").trim()
      .replace(/\s*\(3\.0\)\s*$/, "")
      .replace(/\s*\(3\.5\)\s*$/, "");
    if (!crName) return null;
    // No `as_character IS NOT NULL` gate any more: the v3 WALK migrates a
    // book's "X as Characters" sidebars to standalone type=race entries and
    // drops the creature's as_character block, so monster races (Bugbear,
    // Hound Archon, …) resolve against the creature's TOP-LEVEL
    // special_abilities / special_attacks / special_qualities. Legacy
    // (not-yet-walked) creatures still carry as_character — read both.
    const row = DB.queryOne(
      "SELECT name, source, version, " +
      "  json_extract(data, '$.special_abilities') AS detail, " +
      "  json_extract(data, '$.as_character.special_attacks') AS ac_sa, " +
      "  json_extract(data, '$.as_character.special_qualities') AS ac_sq, " +
      "  json_extract(data, '$.special_attacks') AS sa, " +
      "  json_extract(data, '$.special_qualities') AS sq, " +
      "  json_extract(data, '$.type') AS ctype " +
      "FROM entry WHERE type='creature' AND name = ? COLLATE NOCASE " +
      "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
      [crName]
    );
    if (!row) return null;
    const parseArr = (s) => {
      try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; }
      catch (e) { return []; }
    };
    // special_attacks/qualities come in two shapes: a JSON array (as_character
    // blocks) OR a free-text comma string (creature stat blocks — "Aura of
    // menace, change shape, damage reduction 10/evil, …"). Normalize both.
    const parseList = (s) => {
      if (s == null) return [];
      let v; try { v = JSON.parse(s); } catch (e) { v = s; }
      if (Array.isArray(v)) return v.filter((x) => typeof x === "string");
      if (typeof v === "string") return v.split(",").map((x) => x.trim()).filter(Boolean);
      return [];
    };
    const detail = parseArr(row.detail);
    // Subtype traits: a monster's subtype (Archon, Baatezu, Tanar'ri, …)
    // carries full ability prose in a shared "X Traits" rule. The walk's
    // stat block is terse ("Aura of Menace [Su]: Will DC 16 negates."), so
    // merge the fuller per-ability descriptions from the subtype rule(s) into
    // the detailed pool. Subtypes come from the type=race entry's structured
    // list, falling back to the creature's type parenthetical
    // ("Outsider (Archon, Extraplanar, …)").
    const raceRow = DB.queryOne(
      "SELECT json_extract(data, '$.subtypes') AS subs FROM entry " +
      "WHERE type='race' AND name = ? COLLATE NOCASE LIMIT 1", [crName]);
    let subtypes = parseArr(raceRow && raceRow.subs);
    if (!subtypes.length) {
      const m = String(row.ctype || "").match(/\(([^)]+)\)/);
      subtypes = m ? m[1].split(",").map((x) => x.trim()).filter(Boolean) : [];
    }
    const subtypeAbilities = [];
    for (const st of subtypes) {
      if (!st) continue;
      const rule = DB.queryOne(
        "SELECT json_extract(data, '$.description') AS d FROM entry " +
        "WHERE type='rule' AND name LIKE ? ORDER BY length(name) LIMIT 1",
        [st + "%Trait%"]);
      if (rule && rule.d) {
        for (const a of parseSubtypeTraits(rule.d)) subtypeAbilities.push(a);
      }
    }
    const detailed = detail.concat(subtypeAbilities);
    const known = parseList(row.ac_sa).concat(parseList(row.ac_sq))
      .concat(parseList(row.sa)).concat(parseList(row.sq));
    const rowNorm = normAbility(text.split(/\r?\n/)[0]);
    if (!rowNorm) return null;

    // Match the row against a candidate list by exact-normalized name,
    // then by a length-guarded substring match (catches "Regeneration 5"
    // → "Regeneration" and "Immunity to sleep and charm effects" →
    // "Immunity to Sleep and Charm"). Returns the best (longest) hit.
    const matchIn = (items, nameOf) => {
      let best = null, bestLen = -1;
      for (const it of items) {
        const n = normAbility(nameOf(it));
        if (!n) continue;
        const hit = n === rowNorm
          || (n.length >= 4 && rowNorm.includes(n))
          || (rowNorm.length >= 4 && n.includes(rowNorm));
        if (hit && n.length > bestLen) { best = it; bestLen = n.length; }
      }
      return best;
    };

    const verBadge = (window.VersionBadge ? VersionBadge.html(row.version) : "");
    const attribution = ` <span style="opacity:.7">(${escapeHtml(row.name)} ` +
      `creature ability)</span>`;

    // Tier 1 — structured rules text. Match the row against the creature's
    // own special_abilities PLUS its subtype-trait abilities, preferring the
    // FULLEST description (the subtype rule's full prose wins over a terse
    // stat-block note when an ability appears in both).
    let block = null, bestDescLen = -1;
    for (const d of detailed) {
      if (!d || !d.name) continue;
      const n = normAbility(d.name);
      if (!n) continue;
      const hit = n === rowNorm
        || (n.length >= 4 && rowNorm.includes(n))
        || (rowNorm.length >= 4 && n.includes(rowNorm));
      const dl = (d.description || "").length;
      if (hit && dl > bestDescLen) { block = d; bestDescLen = dl; }
    }
    if (block) {
      const kind = (block.kind || "").trim();
      const tagHtml = kind
        ? ` <span style="opacity:.7">[${escapeHtml(kind)}]</span>` : "";
      const bits = [];
      bits.push(`<b>${escapeHtml(block.name)}</b>${tagHtml}${verBadge}` +
        attribution);
      if (block.description && block.description.trim()) {
        bits.push(escapeHtml(block.description));
      }
      return { html: bits.join("<br>"), entryId: null };
    }

    // Tier 2 — a listed ability with no detail block: be honest.
    const listed = matchIn(known, (s) => s);
    if (listed) {
      const bits = [];
      bits.push(`<b>${escapeHtml(listed)}</b>${verBadge}${attribution}`);
      bits.push('<i style="opacity:.6">No detailed rules text for this ' +
        'creature ability in the database — see the source book' +
        (row.source ? ` (${escapeHtml(row.source)})` : "") + ".</i>");
      return { html: bits.join("<br>"), entryId: null };
    }

    return null;
  }

  // Resolve a skill-trick row to its DB entry. The special-ability
  // picker formats rows as `Name · category skill trick\nbenefit`, so we
  // take the first line up to the " · " separator (tolerating a bare
  // name) and look it up directly. Skill tricks ARE self-contained
  // `entry` rows, so we return the id and let the caller attach errata.
  function renderSkillTrickRules(text) {
    const firstLine = text.split(/\r?\n/)[0];
    const name = firstLine.split(" · ")[0].trim();
    if (!name) return null;
    const row = DB.queryOne(
      "SELECT id, name, source, version, " +
      "  json_extract(data, '$.category')      AS category, " +
      "  json_extract(data, '$.prerequisites') AS prerequisites, " +
      "  json_extract(data, '$.benefit')       AS benefit, " +
      "  json_extract(data, '$.description')   AS description " +
      "FROM entry WHERE type='skill_trick' AND name = ? COLLATE NOCASE " +
      "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
      [name]
    );
    if (!row) return null;
    const verBadge = (window.VersionBadge ? VersionBadge.html(row.version) : "");
    const bits = [];
    bits.push(`<b>${escapeHtml(row.name)}</b>${verBadge}` +
      ` <span style="opacity:.7">(${escapeHtml(row.source || "?")})</span>`);
    if (row.category)      bits.push(`<b>Category:</b> ${escapeHtml(row.category)}`);
    if (row.prerequisites) bits.push(`<b>Prereq:</b> ${escapeHtml(row.prerequisites)}`);
    if (row.benefit)       bits.push(`<b>Benefit:</b> ${escapeHtml(row.benefit)}`);
    if (row.description && row.description !== row.benefit) {
      bits.push(escapeHtml(row.description));
    }
    return { html: bits.join("<br>"), entryId: row.id };
  }

  function collectData() {
    const data = {};
    // Scope to #feats-container and #special-abilities-container — a
    // global `.feat-entry` selector accidentally matches placeholder
    // <div>s in the Companion tab (`comp-feats-list`, `comp-tricks-list`
    // share the `feat-entry` styling class), which previously made the
    // saved `feats` array end with stray nulls per companion list.
    const featsRoot = $("#feats-container");
    const specRoot = $("#special-abilities-container");
    data.feats = [];
    if (featsRoot) {
      featsRoot.querySelectorAll(".feat-entry")
        .forEach((input) => {
          // Bloodline-injected bonus-feat rows are DERIVED from the
          // bloodline selection (bloodline.js#syncBonusFeats), not user
          // data — skip them so they don't double-persist (they re-derive
          // on load). Marked via data-from-bloodline on the textarea.
          if (input.dataset.fromBloodline === "1") return;
          // Class-granted bonus feats (Track/Endurance/Scribe Scroll) are
          // likewise DERIVED from the applied classes
          // (class-picker.js#syncClassBonusFeats) — skip so they re-derive
          // on load rather than double-persisting.
          if (input.dataset.fromClassFeat === "1") return;
          // Soulmeld-granted feats (Kruthik Claws' Weapon Finesse, Wormtail
          // Belt's Awesome Blow) are DERIVED from what is shaped and bound
          // right now (soulmeld-effects.js#syncGrantedFeats) — skip so they
          // re-derive on load. Persisting them would freeze a bind the player
          // may since have moved, and would survive unshaping the soulmeld.
          if (input.dataset.fromSoulmeld === "1") return;
          data.feats.push(input.value);
        });
    }
    data.specialAbilities = [];
    if (specRoot) {
      specRoot.querySelectorAll(".special-ability-entry")
        .forEach((input) => {
          // Preserve the class-origin marker (see addSpecialAbility) so a
          // later class re-apply can dedupe its own entries. Plain user-typed
          // abilities stay as bare strings for backward-compat with old saves.
          // Likewise derived, and for the same reason.
          if (input.dataset.fromSoulmeld === "1") return;
          const fromClass = input.dataset.fromClass;
          data.specialAbilities.push(
            fromClass ? { text: input.value, fromClass } : input.value
          );
        });
    }
    data.languages = $("#languages").value;
    return data;
  }

  function loadData(data) {
    if (data.languages !== undefined) $("#languages").value = data.languages;
    $("#feats-container").innerHTML = "";
    // Filter out null/empty entries on load. Legacy saved characters
    // (pre-2026-05-15 collector fix) may have accumulated trailing nulls
    // from the unscoped `.feat-entry` selector picking up companion-tab
    // <div>s. Without this filter, each null becomes an empty feat row
    // (the reported "four empty feats keep showing up" bug). New saves
    // are clean, but legacy localStorage entries still need this guard.
    const realFeats = (data.feats || []).filter(
      (f) => f != null && String(f).trim() !== ""
    );
    realFeats.forEach((f) => addFeat(f));
    // NO placeholder row. An empty list is empty — "+ Add Feat" is right
    // there, and a blank row is a row you have to notice is blank, delete,
    // or scroll past (report rms8uiy6j-hvqk).
    $("#special-abilities-container").innerHTML = "";
    // Entries are either a bare string (user-typed / legacy) or a
    // { text, fromClass } object (class-derived, carrying its origin marker).
    const specText = (a) => (typeof a === "string" ? a : (a && a.text) || "");
    const realSpec = (data.specialAbilities || []).filter(
      (a) => a != null && String(specText(a)).trim() !== ""
    );
    realSpec.forEach((a) => {
      if (typeof a === "string") addSpecialAbility(a);
      else addSpecialAbility(a.text || "", a.fromClass || null);
    });
    // (No placeholder row here either — see the feats note above.)
    // Signal "feats changed" so spells.js can re-sync ✨ button
    // visibility on Known rows and the metamagic-reference panel.
    // Without this, the load-order bug — Spells.loadData runs BEFORE
    // Feats.loadData in app.js's loadData() — leaves the ✨ buttons
    // hidden on every saved character that has metamagic feats: the
    // buttons were created during Spells.loadData when no feats had
    // been restored yet, so characterHasAnyMetamagic() returned 0.
    // A synthetic 'input' event bubbling from a feat row triggers
    // the listener in spells.js, which calls
    // refreshAllKnownRowMetamagicVis() + refreshMetamagicReference().
    // Dispatch from the CONTAINER, not the first row: the list can now
    // legitimately be empty, and firing off a row meant a feat-less
    // character never sent the signal at all. spells.js's listener only
    // cares that the event came from inside #tab-feats.
    const featsHost = $("#feats-container");
    if (featsHost) {
      featsHost.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // ---- Structured feat bonuses (effects-aggregator phase 3) -------------
  // The ~19 core flat-bonus PHB feats carry a structured `bonuses` array in
  // the DB (Iron Will +2 Will, Alertness +2 Listen/Spot, Skill Focus +3 to a
  // chosen skill, …). The character's feat rows resolve to those bonuses and
  // feed the SAME skill / save / AC aggregator as race/template/bloodline.
  let _featBonusMap = null;
  function featBonusMap() {
    if (_featBonusMap) return _featBonusMap;
    const m = new Map();
    if (window.DB && DB.isLoaded()) {
      const rows = DB.query(
        "SELECT name, json_extract(data,'$.bonuses') AS bonuses FROM entry "
        + "WHERE type='feat' AND json_extract(data,'$.bonuses') IS NOT NULL");
      for (const r of rows) {
        try { m.set(String(r.name).toLowerCase(), JSON.parse(r.bonuses)); }
        catch (e) { /* skip */ }
      }
      _featBonusMap = m;   // cache only once the DB is loaded
    }
    return m;
  }

  // Resolve the character's feat rows → a flat list of structured bonuses,
  // filling a "@choice" target from the feat row's parenthetical
  // ("Skill Focus (Diplomacy)" → Diplomacy). Includes derived bonus-feat
  // rows (a bloodline/class-granted Iron Will still grants +2 Will).
  function getResolvedFeatBonuses() {
    const map = featBonusMap();
    if (!map.size) return [];
    const out = [];
    document.querySelectorAll("#feats-container .feat-entry").forEach((ta) => {
      const text = (ta.value || "").trim();
      if (!text) return;
      const m = text.match(/^([^(]+?)\s*(?:\(([^)]*)\))?\s*$/);
      if (!m) return;
      const bonuses = map.get(m[1].trim().toLowerCase());
      if (!bonuses) return;
      const spec = (m[2] || "").trim();
      const featName = m[1].trim();
      for (const b of bonuses) {
        // Ability-linked rows (Force of Personality Cha-for-Wis, Tactile
        // Trapsmith Dex-for-Int) resolve to a flat row off the live
        // ability mods FIRST; whatever stays non-flat is then guarded.
        let src = b;
        if (typeof DND35 !== "undefined" && DND35.resolveAbilityLinkedBonus) {
          const resolved = DND35.resolveAbilityLinkedBonus(b);
          if (resolved) src = resolved;
        }
        // Marker guard: scaling rows / ally- or enemy-scoped rows are not
        // flat self bonuses — skip them here so the skill path's manual
        // routing (which bypasses the categorizers) can't consume them.
        if (typeof DND35 !== "undefined" && DND35.flatBonusRowOk &&
            !DND35.flatBonusRowOk(src)) continue;
        const bonus = Object.assign({}, src);
        if (bonus.target === "@choice") {
          if (!spec) continue;             // unresolved specialization → skip
          bonus.target = spec;
        }
        // Tag with the granting feat so situational notes can name their
        // source (flows through the save/AC categorizers' source pass-through
        // and the skill path's manual push below).
        bonus.source = featName;
        out.push(bonus);
      }
    });
    return out;
  }

  // Skill bonuses: feat skill bonuses are UNTYPED, so same-skill bonuses SUM
  // (Alertness +2 Listen + Skill Focus (Listen) +3 = +5). {direct, global,
  // situational} to match the other pickers' shape that skills.js consumes.
  function getActiveSkillBonuses() {
    const direct = {};
    const situational = [];
    for (const b of getResolvedFeatBonuses()) {
      if (b.bonus_type !== "skill" || !b.target || typeof b.amount !== "number") continue;
      // Conditional feat skill bonuses (the DEFERRED_CONDITIONAL set —
      // "+4 Jump with a running start", "+2 Balance/Tumble aboard a ship")
      // route to a per-skill situational NOTE, mirroring the trait/flaw path,
      // instead of summing into the always-on total. skills.js concatenates
      // featSkill.situational alongside the race/template/trait ones.
      const cond = (b.condition == null) ? "" : String(b.condition).trim();
      if (cond) {
        situational.push({ skill: String(b.target), amount: b.amount,
          condition: cond, category: b.bonus_category, source: b.source });
        continue;
      }
      const k = String(b.target).toLowerCase();
      direct[k] = (direct[k] || 0) + b.amount;
    }
    return { direct, global: 0, situational };
  }
  function getActiveSaveBonuses() {
    return (typeof DND35 !== "undefined" && DND35.categorizeSaveBonuses)
      ? DND35.categorizeSaveBonuses(getResolvedFeatBonuses())
      : { direct: { fort: [], ref: [], will: [] }, situational: [] };
  }
  function getActiveACBonuses() {
    return (typeof DND35 !== "undefined" && DND35.categorizeACBonuses)
      ? DND35.categorizeACBonuses(getResolvedFeatBonuses())
      : { items: [], situational: [] };
  }
  function getActiveInitiativeBonuses() {
    return (typeof DND35 !== "undefined" && DND35.categorizeInitiativeBonuses)
      ? DND35.categorizeInitiativeBonuses(getResolvedFeatBonuses())
      : { direct: [], situational: [] };
  }
  // Movement-speed feat bonuses (effects-aggregator P2). Returns the RAW
  // speed-typed entries; app.js concats + categorizes across all sources.
  // Empty until feats carry structured `bonus_type:'speed'` (P4 data pass).
  function getActiveSpeedBonuses() {
    return getResolvedFeatBonuses()
      .filter(b => String(b.bonus_type || "").toLowerCase() === "speed");
  }

  // Weapon Focus / Greater Weapon Focus → +1 (each) to attack rolls with the
  // named weapon. Returns { weaponNameLower: totalBonus }. Consumed by
  // character.js's per-attack calculator, matched case-insensitively against
  // each attack row's weapon name. Greater stacks on top of base per RAW
  // (a character with both Weapon Focus + Greater Weapon Focus for a weapon
  // yields +2). Feats without a parenthetical (no chosen weapon) are skipped —
  // there's nothing to match against. Derived bonus-feat rows are included
  // (they're .feat-entry rows too).
  // Does the character currently have a feat by this name? Case-insensitive
  // and tolerant of a trailing "(...)" qualifier (e.g. "Power Attack (Str 17)").
  // Cross-module effect recognition uses this — e.g. class-picker's Divine Grace
  // checks for the Serenity feat to swap the linked ability Cha → Wis.
  function hasFeat(name) {
    const target = String(name || "").trim().toLowerCase();
    if (!target) return false;
    return Array.from(document.querySelectorAll("#feats-container .feat-entry"))
      .some((ta) => String(ta.value || "").trim().toLowerCase()
        .replace(/\s*\([^)]*\)\s*$/, "") === target);
  }

  function getWeaponFocusBonuses() {
    const out = {};
    document.querySelectorAll("#feats-container .feat-entry").forEach((ta) => {
      const text = (ta.value || "").trim();
      if (!text) return;
      const m = text.match(/^\s*(?:greater\s+)?weapon\s+focus\s*\(([^)]+)\)/i);
      if (!m) return;
      const weapon = m[1].trim().toLowerCase();
      if (weapon) out[weapon] = (out[weapon] || 0) + 1;
    });
    return out;
  }

  // Weapon Specialization / Greater Weapon Specialization → +2 DAMAGE each with
  // the named weapon (PHB: "You gain a +2 bonus on all damage rolls you make
  // using the selected weapon"). Mirrors getWeaponFocusBonuses, which returns
  // +1 per feat because Focus grants +1; Specialization grants +2, so the value
  // is the bonus rather than a count — the consumer adds what it is given.
  // Returns { weaponLower: totalDamageBonus }.
  // Power Critical (Complete Warrior) → +4 on the roll to CONFIRM a threat with
  // the named weapon. Same weapon-parameterized shape as Weapon Focus.
  //
  // Note on the 3.5 landscape here, because it is easy to reach for the wrong
  // feat: there is no "Critical Focus" in 3.5 (that is Pathfinder). A DB sweep
  // for feats that touch confirmation finds nine, and only Power Critical is an
  // unconditional, weapon-named, always-on bonus — which is why it is the only
  // one auto-filled. Confound the Big Folk (+4 vs larger foes), Vow of
  // Vengeance (+4 profane vs the sworn enemy) and Mark of Avernus (auto-confirm)
  // are all situational, and Cobalt Critical / Cobalt Precision are incarnum
  // feats scaled by essentia invested in the FEAT, which the sheet does not
  // model. Auto-filling any of those would assert a bonus the character only
  // sometimes has.
  // Returns { weaponLower: totalConfirmBonus }.
  function getCritConfirmBonuses() {
    const out = {};
    document.querySelectorAll("#feats-container .feat-entry").forEach((ta) => {
      const text = (ta.value || "").trim();
      if (!text) return;
      const m = text.match(/^\s*power\s+critical\s*\(([^)]+)\)/i);
      if (!m) return;
      const weapon = m[1].trim().toLowerCase();
      if (weapon) out[weapon] = (out[weapon] || 0) + 4;
    });
    return out;
  }

  // Improved Natural Attack: "the damage for this natural weapon increases by
  // one step, as if the creature's size had increased by one category". Per
  // natural weapon, chosen at the time you take it, so it is keyed by weapon
  // name exactly like Weapon Focus and Specialization — and stacks with itself
  // if taken twice for the same attack form, which the MM allows.
  //
  // Returns {weaponname: steps}. The STEP TABLE is not here: it is
  // DND35.stepWeaponDamage, shared with the soulmeld binds that step damage
  // for their own reason ("as if you were one size category larger"). One
  // table, because it is one rule wearing two hats, and the MM prints the same
  // progression this feat and those binds both refer to.
  function getNaturalAttackSteps() {
    const out = {};
    document.querySelectorAll("#feats-container .feat-entry").forEach((ta) => {
      const text = (ta.value || "").trim();
      if (!text) return;
      const m = text.match(/^\s*improved\s+natural\s+attack\s*\(([^)]+)\)/i);
      if (!m) return;
      const weapon = m[1].trim().toLowerCase();
      if (weapon) out[weapon] = (out[weapon] || 0) + 1;
    });
    return out;
  }

  function getWeaponSpecBonuses() {
    const out = {};
    document.querySelectorAll("#feats-container .feat-entry").forEach((ta) => {
      const text = (ta.value || "").trim();
      if (!text) return;
      // "Weapon Specialization (Longsword)" / "Greater Weapon Specialization
      // (Longsword)". Anchored so "Melee Weapon Specialization" or a note
      // mentioning the feat in passing doesn't match.
      const m = text.match(/^\s*(?:greater\s+)?weapon\s+specialization\s*\(([^)]+)\)/i);
      if (!m) return;
      const weapon = m[1].trim().toLowerCase();
      if (weapon) out[weapon] = (out[weapon] || 0) + 2;
    });
    return out;
  }

  // Grapple-check bonuses granted by feats. Improved Grapple is a flat +4 on
  // ALL grapple checks (PHB p.95) — unconditional, so it folds straight into
  // the grapple total. Returns { amount, sources:[{name,amount}] } so the
  // grapple breakdown can show a labelled Feat component. A small table so any
  // future grapple-check feat is one line to add.
  const FEAT_GRAPPLE_BONUS = { "Improved Grapple": 4 };
  function getGrappleBonus() {
    let amount = 0;
    const sources = [];
    for (const [feat, bonus] of Object.entries(FEAT_GRAPPLE_BONUS)) {
      if (hasFeat(feat)) { amount += bonus; sources.push({ name: feat, amount: bonus }); }
    }
    return { amount, sources };
  }

  // Spell Focus / Greater Spell Focus → +1 (each) to save DCs for spells of the
  // named school. Returns { schoolLower: totalBonus }. Surfaced as a note by
  // spells.js — the sheet's DC display is per spell-LEVEL, not per-school/spell,
  // so we annotate the caster panel rather than fold into the blanket per-level
  // DC. Greater stacks on base (both feats for one school → +2).
  function getSpellFocusBonuses() {
    const out = {};
    document.querySelectorAll("#feats-container .feat-entry").forEach((ta) => {
      const text = (ta.value || "").trim();
      if (!text) return;
      const m = text.match(/^\s*(?:greater\s+)?spell\s+focus\s*\(([^)]+)\)/i);
      if (!m) return;
      const school = m[1].trim().toLowerCase();
      if (school) out[school] = (out[school] || 0) + 1;
    });
    return out;
  }

  return {
    addFeat, addSpecialAbility, collectData, loadData,
    // Exposed for the Companion tab's feat list — same lookup logic
    // (DB query by feat name + parenthetical-stripping fallback) used
    // by the per-row ⓘ toggle on the main Feats tab.
    renderFeatRules,
    // Effects-aggregator phase 3.
    getResolvedFeatBonuses, getActiveSkillBonuses,
    getActiveSaveBonuses, getActiveACBonuses, getActiveSpeedBonuses,
    getActiveInitiativeBonuses,
    getWeaponFocusBonuses, getWeaponSpecBonuses, getNaturalAttackSteps,
    getSpellFocusBonuses,
    getCritConfirmBonuses, getGrappleBonus,
    // Feat presence check for cross-module effect recognition (e.g. Serenity).
    hasFeat,
    // Structured-feat-entry helpers (exposed for tests).
    parseFeatText, lookupFeatInfo,
  };
})();
