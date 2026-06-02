// D&D 3.5 Character Sheet - Feats & Abilities Module

const Feats = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function addFeat(text = "") {
    const container = $("#feats-container");
    const div = document.createElement("div");
    div.className = "feat-row";
    const ta = document.createElement("textarea");
    ta.className = "feat-entry";
    ta.placeholder = "Feat name & details";
    ta.rows = 1;
    ta.value = text;
    // ⓘ button toggles a collapsible panel below the row showing the
    // feat's rules text (type, prereq, benefit, normal, special) pulled
    // from the DB. Falls back gracefully for homebrew / custom entries
    // that don't match a DB row. The panel is generated on demand and
    // not persisted — collapses again if the textarea is edited.
    const info = document.createElement("button");
    info.type = "button";
    info.className = "btn-feat-info";
    info.title = "Show rules text";
    info.setAttribute("aria-expanded", "false");
    info.textContent = "ⓘ";
    info.addEventListener("click", () => toggleFeatRules(div));
    // Prereq audit badge — shows ✓ / ✗ / ? next to each existing
    // feat row based on the character's current state. Click to
    // expand a detailed atom-by-atom breakdown inline.
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
    // Collapse the rules panel + refresh the prereq badge whenever
    // the user edits the feat name.
    ta.addEventListener("input", () => {
      collapseFeatRules(div);
      refreshFeatPrereqBadge(div);
    });
    div.appendChild(ta);
    div.appendChild(info);
    div.appendChild(prereq);
    div.appendChild(btn);
    container.appendChild(div);
    // Initial badge render (also triggered on subsequent edits).
    refreshFeatPrereqBadge(div);
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
      "  json_extract(e.data, '$.description')   AS description " +
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
          "  json_extract(e.data, '$.description')   AS description " +
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

  function addSpecialAbility(text = "") {
    const container = $("#special-abilities-container");
    const div = document.createElement("div");
    div.className = "feat-row";
    const ta = document.createElement("textarea");
    ta.className = "special-ability-entry";
    ta.placeholder = "Ability name & description";
    ta.rows = 1;
    ta.value = text;
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
  // Both the racial and creature resolvers key off #char-race: the
  // race-picker writes the race name there, and the creature-race-picker
  // writes the CREATURE's name there too (it owns #char-race as "the
  // canonical Race field"; its own #char-creature-race input is transient
  // and cleared after apply). #char-race persists via Character, so this
  // works live AND after a save/reload. Racial runs first because real
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
    if (feat.description) {
      bits.push(escapeHtml(feat.description));
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
      "  json_extract(data, '$.traits') AS t " +
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
    const trait = traits.find(
      t => (t && t.name || "").trim().toLowerCase() === candidate
    );
    if (!trait) return null;
    const tag = (trait.tag || "").trim();
    const tagHtml = tag
      ? ` <span style="opacity:.7">[${escapeHtml(tag)}]</span>` : "";
    const verBadge = (window.VersionBadge ? VersionBadge.html(row.version) : "");
    const bits = [];
    bits.push(`<b>${escapeHtml(trait.name)}</b>${tagHtml}${verBadge}` +
      ` <span style="opacity:.7">(${escapeHtml(row.name)} racial trait)</span>`);
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
  function renderCreatureAbilityRules(text) {
    const raceInput = document.getElementById("char-race");
    const crName = (raceInput && raceInput.value || "").trim()
      .replace(/\s*\(3\.0\)\s*$/, "")
      .replace(/\s*\(3\.5\)\s*$/, "");
    if (!crName) return null;
    const row = DB.queryOne(
      "SELECT name, source, version, " +
      "  json_extract(data, '$.special_abilities') AS detail, " +
      "  json_extract(data, '$.as_character.special_attacks') AS ac_sa, " +
      "  json_extract(data, '$.as_character.special_qualities') AS ac_sq " +
      "FROM entry WHERE type='creature' AND name = ? COLLATE NOCASE " +
      "  AND json_extract(data, '$.as_character') IS NOT NULL " +
      "ORDER BY CASE version WHEN '3.5' THEN 0 ELSE 1 END LIMIT 1",
      [crName]
    );
    if (!row) return null;
    const parseArr = (s) => {
      try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; }
      catch (e) { return []; }
    };
    const detail = parseArr(row.detail);
    const known = parseArr(row.ac_sa).concat(parseArr(row.ac_sq))
      .filter((x) => typeof x === "string");
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

    // Tier 1 — structured rules text.
    const block = matchIn(detail, (d) => d && d.name);
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
          data.feats.push(input.value);
        });
    }
    data.specialAbilities = [];
    if (specRoot) {
      specRoot.querySelectorAll(".special-ability-entry")
        .forEach((input) => data.specialAbilities.push(input.value));
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
    // Always show at least one empty row so the user has a place to type.
    if (!realFeats.length) addFeat();
    $("#special-abilities-container").innerHTML = "";
    const realSpec = (data.specialAbilities || []).filter(
      (a) => a != null && String(a).trim() !== ""
    );
    realSpec.forEach((a) => addSpecialAbility(a));
    if (!realSpec.length) addSpecialAbility();
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
    const firstFeatEntry = $("#feats-container .feat-entry");
    if (firstFeatEntry) {
      firstFeatEntry.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  return {
    addFeat, addSpecialAbility, collectData, loadData,
    // Exposed for the Companion tab's feat list — same lookup logic
    // (DB query by feat name + parenthetical-stripping fallback) used
    // by the per-row ⓘ toggle on the main Feats tab.
    renderFeatRules,
  };
})();
