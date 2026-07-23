// D&D 3.5 Character Sheet - Skills Module

const Skills = (function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const int = (v) => parseInt(v) || 0;
  const expr = (v) => DND35.evalExpr(v);
  const fmt = (n) => (n >= 0 ? "+" + n : String(n));

  // Frozen snapshot of the PRE-2026-07-01 skill INDEX order. Saves made
  // before skills.js switched to name-keyed load/save carry only a numeric
  // `index` (no `name`), so this table maps that legacy index → display
  // name, letting old saves migrate onto the now-ALPHABETICAL DND35.skills
  // array. DO NOT reorder or edit this — it is a historical key that
  // nameless saves depend on, not the live skill order. New saves store
  // `name`/`baseName` and never consult it.
  const LEGACY_SKILL_ORDER = [
    "Appraise", "Balance", "Bluff", "Climb", "Concentration", "Craft",
    "Decipher Script", "Diplomacy", "Disable Device", "Disguise",
    "Escape Artist", "Forgery", "Gather Information", "Handle Animal",
    "Heal", "Hide", "Intimidate", "Jump", "Knowledge (Arcana)",
    "Knowledge (Arch. & Eng.)", "Knowledge (Dungeoneering)",
    "Knowledge (Geography)", "Knowledge (History)", "Knowledge (Local)",
    "Knowledge (Nature)", "Knowledge (Nobility)", "Knowledge (The Planes)",
    "Knowledge (Religion)", "Listen", "Move Silently", "Open Lock",
    "Perform", "Profession", "Ride", "Search", "Sense Motive",
    "Sleight of Hand", "Speak Language", "Spellcraft", "Spot", "Survival",
    "Swim", "Tumble", "Use Magic Device", "Use Rope", "Autohypnosis",
    "Control Shape", "Iaijutsu Focus", "Knowledge (Psionics)",
    "Lucid Dreaming", "Martial Lore", "Psicraft", "Truespeak",
    "Use Psionic Device",
  ];

  // ============================================================
  // Build the skills table from DND35.skills
  // ============================================================
  function build(getAbilityMod) {
    const tbodyL = $("#skills-body-left");
    const tbodyR = $("#skills-body-right");
    tbodyL.innerHTML = "";
    tbodyR.innerHTML = "";

    // Split skills roughly in half
    const midpoint = Math.ceil(DND35.skills.length / 2);
    DND35.skills.forEach((skill, i) => {
      const tbody = i < midpoint ? tbodyL : tbodyR;
      if (skill.editableSubtype) {
        addSubtypeGroup(tbody, skill, i);
      } else {
        addSkillRow(tbody, skill, i, getAbilityMod);
      }
    });

    tbodyL.addEventListener("input", () => recalc(getAbilityMod));
    tbodyR.addEventListener("input", () => recalc(getAbilityMod));
  }

  function addSkillRow(tbody, skill, index, getAbilityMod, opts = {}) {
    const tr = document.createElement("tr");
    tr.dataset.ability = skill.ability;
    tr.dataset.acp = skill.armorPenalty;
    tr.dataset.doubleAcp = skill.doubleArmorPenalty || false;
    tr.dataset.skillIndex = index;
    if (opts.subtypeOf) tr.dataset.subtypeOf = opts.subtypeOf;

    let displayName;
    if (skill.hasSubtype && skill.subtypeLabel) {
      displayName = `${skill.name} (${skill.subtypeLabel})`;
    } else {
      displayName = skill.name;
    }

    let markers = "";
    if (skill.untrained) markers += '<span class="skill-untrained-marker" title="Can be used untrained">U</span>';
    if (skill.armorPenalty) markers += '<span class="skill-acp-marker" title="Armor check penalty applies">*</span>';

    tr.innerHTML = `
      <td class="skill-class-col"><input type="checkbox" class="skill-class-check" title="Class Skill?"></td>
      <td class="skill-name-col">
        <span class="skill-name">${displayName}</span>${markers}
        <span class="synergy-info"></span>
        <button class="skill-notes-toggle" title="Situational modifiers">&#9776;</button>
      </td>
      <td class="skill-ability-col">${skill.ability}</td>
      <td class="skill-total-col"><span class="skill-total calc-field">+0</span></td>
      <td class="skill-ability-mod-col"><span class="skill-ability-mod">${fmt(0)}</span></td>
      <td class="skill-ranks-col"><input type="number" class="skill-ranks" value="0" min="0" step="0.5"></td>
      <td class="skill-misc-col"><input type="text" class="skill-misc" value="0"></td>
    `;
    tbody.appendChild(tr);

    // Notes toggle
    const toggleBtn = tr.querySelector(".skill-notes-toggle");
    toggleBtn.addEventListener("click", () => toggleNotes(tr, toggleBtn));

    return tr;
  }

  // ============================================================
  // Subtype groups (Craft, Perform, Profession)
  // ============================================================
  function addSubtypeGroup(tbody, skill, index) {
    // Create a container row with the base skill name and an "add" button
    const headerTr = document.createElement("tr");
    headerTr.className = "subtype-header-row";
    headerTr.dataset.subtypeBase = skill.name;
    headerTr.dataset.skillIndex = index;
    headerTr.innerHTML = `
      <td colspan="7" style="padding:0.3rem 0.25rem 0.1rem">
        <span style="font-weight:600;font-size:0.8rem;">${skill.name}</span>
        <span class="skill-untrained-marker" title="Can be used untrained">${skill.untrained ? "U" : ""}</span>
        <button class="btn-add-subtype" data-skill-name="${skill.name}" data-skill-index="${index}">+ add subtype</button>
      </td>
    `;
    tbody.appendChild(headerTr);

    // Add one default empty subtype entry
    addSubtypeEntry(tbody, skill, index, "");

    // Wire up the add button
    headerTr.querySelector(".btn-add-subtype").addEventListener("click", () => {
      addSubtypeEntry(tbody, skill, index, "");
      // Move the next non-subtype rows after this group
      reorderAfterSubtype(tbody, index);
    });
  }

  function addSubtypeEntry(tbody, skill, index, subtypeName, data = {}) {
    const tr = document.createElement("tr");
    tr.className = "subtype-skill-group";
    tr.dataset.ability = skill.ability;
    tr.dataset.acp = skill.armorPenalty || false;
    tr.dataset.doubleAcp = false;
    tr.dataset.skillIndex = index;
    tr.dataset.subtypeOf = skill.name;
    tr.dataset.isSubtype = "true";

    const markers = skill.armorPenalty ? '<span class="skill-acp-marker" title="Armor check penalty applies">*</span>' : '';

    tr.innerHTML = `
      <td class="skill-class-col"><input type="checkbox" class="skill-class-check" title="Class Skill?"></td>
      <td class="skill-name-col">
        <div class="subtype-skill-name">
          <span class="skill-base-name">${skill.name} (</span>
          <input type="text" class="skill-subtype-input" placeholder="subtype" value="${subtypeName}">
          <span>)</span>${markers}
          <span class="synergy-info"></span>
          <button class="skill-notes-toggle" title="Situational modifiers">&#9776;</button>
          <button class="btn-remove" style="font-size:0.6rem;padding:0 0.3rem;margin-left:auto" onclick="Skills.removeSubtype(this)">X</button>
        </div>
      </td>
      <td class="skill-ability-col">${skill.ability}</td>
      <td class="skill-total-col"><span class="skill-total calc-field">+0</span></td>
      <td class="skill-ability-mod-col"><span class="skill-ability-mod">${fmt(0)}</span></td>
      <td class="skill-ranks-col"><input type="number" class="skill-ranks" value="${data.ranks || 0}" min="0" step="0.5"></td>
      <td class="skill-misc-col"><input type="text" class="skill-misc" value="${data.misc || 0}"></td>
    `;

    if (data.classSkill) tr.querySelector(".skill-class-check").checked = true;

    // Insert after the header or last subtype of this group
    const existing = tbody.querySelectorAll(`tr[data-skill-index="${index}"]`);
    const lastOfGroup = existing[existing.length - 1];
    if (lastOfGroup && lastOfGroup.nextSibling) {
      tbody.insertBefore(tr, lastOfGroup.nextSibling);
    } else {
      tbody.appendChild(tr);
    }

    // Wire notes toggle
    const toggleBtn = tr.querySelector(".skill-notes-toggle");
    toggleBtn.addEventListener("click", () => toggleNotes(tr, toggleBtn));

    return tr;
  }

  function reorderAfterSubtype(tbody, index) {
    // Ensure subtype entries stay grouped after their header
    // (they already are via insertBefore logic above, this is a safety measure)
  }

  function removeSubtype(btn) {
    const tr = btn.closest("tr");
    // Also remove any notes row following it
    const next = tr.nextElementSibling;
    if (next && next.classList.contains("skill-notes-row-container")) {
      next.remove();
    }
    tr.remove();
  }

  // ── Auto-created subtype rows for structured bonuses ────────────────
  // Races / feats / templates grant bonuses to SPECIFIC Craft / Perform /
  // Profession subtypes (Gnome "+2 Craft (alchemy)"). The bonus only lands
  // if a matching subtype row exists, so we auto-create one on demand
  // (tagged `data-auto-bonus-subtype`) and reconcile it away when the
  // granting source is gone — UNLESS the user has put ranks or notes in it,
  // in which case it's promoted to an ordinary manual subtype row.
  function findSubtypeRow(base, subtype) {
    const bl = base.toLowerCase(), sl = subtype.toLowerCase();
    return [...$$(".subtype-skill-group")].find((tr) =>
      (tr.dataset.subtypeOf || "").toLowerCase() === bl &&
      (tr.querySelector(".skill-subtype-input")?.value || "").trim().toLowerCase() === sl);
  }

  function ensureBonusSubtypeRow(base, subtype) {
    if (findSubtypeRow(base, subtype)) return;   // manual/auto row already present
    const idx = DND35.skills.findIndex((s) => s.name === base && s.editableSubtype);
    if (idx < 0) return;
    const header = [...$$(".subtype-header-row")].find((h) => h.dataset.subtypeBase === base);
    const tbody = header ? header.closest("tbody") : $("#skills-body-left");
    if (!tbody) return;
    // Title-case for display (the bonus key arrives lowercased); matching is
    // always case-insensitive so display casing never affects bonus landing.
    const label = subtype.replace(/\b\w/g, (c) => c.toUpperCase());
    const tr = addSubtypeEntry(tbody, DND35.skills[idx], idx, label);
    tr.dataset.autoBonusSubtype = "1";
  }

  // directKeys: Set of lowercased bonus target names ("craft (alchemy)").
  function syncBonusSubtypes(directKeys) {
    const needed = new Map();   // "craft|alchemy" -> { base, subtype }
    directKeys.forEach((key) => {
      const m = key.match(/^(craft|perform|profession)\s*\((.+)\)\s*$/i);
      if (!m) return;
      const base = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
      needed.set(base.toLowerCase() + "|" + m[2].trim().toLowerCase(),
        { base, subtype: m[2].trim() });
    });
    needed.forEach(({ base, subtype }) => ensureBonusSubtypeRow(base, subtype));
    // Reconcile stale auto rows.
    [...$$(".subtype-skill-group[data-auto-bonus-subtype]")].forEach((tr) => {
      const base = (tr.dataset.subtypeOf || "").toLowerCase();
      const sub = (tr.querySelector(".skill-subtype-input")?.value || "").trim().toLowerCase();
      if (needed.has(base + "|" + sub)) return;   // still granted
      const ranks = tr.querySelector(".skill-ranks")?.value;
      const notes = tr.querySelector(".skill-notes-toggle")?.dataset.notes;
      if ((ranks && ranks !== "0") || notes) { delete tr.dataset.autoBonusSubtype; return; }
      const next = tr.nextElementSibling;
      if (next && next.classList.contains("skill-notes-row-container")) next.remove();
      tr.remove();
    });
  }

  // ============================================================
  // Skill notes (expandable per-skill)
  // ============================================================
  function toggleNotes(skillRow, toggleBtn) {
    const nextRow = skillRow.nextElementSibling;
    if (nextRow && nextRow.classList.contains("skill-notes-row-container")) {
      // Close
      nextRow.remove();
    } else {
      // Open
      const synergy = toggleBtn.dataset.synergy || "";
      const notesTr = document.createElement("tr");
      notesTr.className = "skill-notes-row-container";
      notesTr.innerHTML = `
        <td class="skill-notes-row" colspan="7">
          ${synergy ? `<div class="synergy-notes">${synergy}</div>` : ""}
          <textarea class="skill-notes-input" placeholder="Situational modifiers...">${toggleBtn.dataset.notes || ""}</textarea>
        </td>
      `;
      skillRow.after(notesTr);
      const ta = notesTr.querySelector("textarea");
      ta.addEventListener("input", () => {
        toggleBtn.dataset.notes = ta.value;
        toggleBtn.classList.toggle("has-notes", ta.value.trim() !== "" || !!toggleBtn.dataset.synergy);
        // Auto-expand
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      });
      // Auto-expand on open
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
      ta.focus();
    }
  }

  // ============================================================
  // Recalculate all skill modifiers + synergies
  // ============================================================
  function recalc(getAbilityMod) {
    const acPenalty = int($("#armor-check-penalty").value);
    const equipSkillBonuses = (typeof Equipment !== "undefined" && Equipment.getSkillBonuses) ? Equipment.getSkillBonuses() : {};
    // Item-familiar bonuses (UA pp.170-171): each invested-skill-rank
    // group grants +1 bonuses that can be applied to any skill,
    // bypassing the max-ranks cap. Returns a {skill_name_lower:
    // bonus_total} map.
    const itemFamiliarSkillBonuses = (typeof ItemFamiliar !== "undefined"
      && ItemFamiliar.getAllSkillBonuses)
      ? ItemFamiliar.getAllSkillBonuses() : {};

    // Bloodline skill bonuses (UA Bloodlines). `direct` is an
    // unconditional {skill_lower: bonus} map that folds into the total
    // (a "Perform" key applies to every Perform subtype via base name).
    // `affinity` is the SITUATIONAL social bonus vs creatures of the
    // bloodline — surfaced as a per-skill note, never added to the total.
    const bloodlineSkill = (typeof Bloodline !== "undefined"
      && Bloodline.getActiveSkillBonuses)
      ? Bloodline.getActiveSkillBonuses() : { direct: {}, affinities: [] };
    // One affinity per bloodline, each vs a DIFFERENT creature type (they
    // never overlap), so a social skill can carry several distinct notes.
    const bloodlineAffinities = Array.isArray(bloodlineSkill.affinities)
      ? bloodlineSkill.affinities : [];

    // Size modifier to Hide checks (PHB p.76 / SRD: a creature's size
    // modifies its Hide checks — Fine +16 … Medium +0 … Colossal −16).
    // Pulled from DND35.sizes[size].hideMod so the whole size table is
    // honored, not just Small. Applied to the Hide row only, below.
    const charSize = $("#char-size")?.value || "Medium";
    const hideSizeMod = (DND35.sizes[charSize] && DND35.sizes[charSize].hideMod) || 0;

    // Racial + template skill bonuses (structured `bonuses` rows, decoded
    // by DND35.categorizeSkillBonuses). `direct` per-skill bonuses fold into
    // the total; `global` applies to every skill (e.g. a Paragon template);
    // `situational` (conditional) bonuses render as per-skill notes, never
    // added — mirroring the bloodline affinity treatment. RacePicker handles
    // variant-base inheritance + negations internally; TemplatePicker
    // contributes nothing until the DB reshape adds templates' structured
    // rows (graceful no-op today).
    const raceSkill = (typeof RacePicker !== "undefined" && RacePicker.getActiveSkillBonuses)
      ? RacePicker.getActiveSkillBonuses() : { direct: {}, global: 0, situational: [] };
    const tmplSkill = (typeof TemplatePicker !== "undefined" && TemplatePicker.getActiveSkillBonuses)
      ? TemplatePicker.getActiveSkillBonuses() : { direct: {}, global: 0, situational: [] };
    // Feat skill bonuses (Alertness, Skill Focus, …) — untyped, summed per
    // skill in Feats.getActiveSkillBonuses; same {direct, global} shape.
    const featSkill = (typeof Feats !== "undefined" && Feats.getActiveSkillBonuses)
      ? Feats.getActiveSkillBonuses() : { direct: {}, global: 0, situational: [] };
    // UA trait/flaw skill bonuses (untyped, summed) — same {direct, global,
    // situational} shape; conditional ones (Slippery "to escape a grapple",
    // Nightsighted "in bright light") route to situational notes.
    const traitSkill = (typeof TraitPicker !== "undefined" && TraitPicker.getActiveSkillBonuses)
      ? TraitPicker.getActiveSkillBonuses() : { direct: {}, global: 0, situational: [] };
    // Class-feature skill bonuses (Druid Nature Sense, …) — same shape.
    const classSkill = (typeof ClassPicker !== "undefined" && ClassPicker.getActiveSkillBonuses)
      ? ClassPicker.getActiveSkillBonuses() : { direct: {}, global: 0, situational: [] };
    const racialSituational = [].concat(
      Array.isArray(raceSkill.situational) ? raceSkill.situational : [],
      Array.isArray(tmplSkill.situational) ? tmplSkill.situational : [],
      Array.isArray(featSkill.situational) ? featSkill.situational : [],
      Array.isArray(classSkill.situational) ? classSkill.situational : [],
      Array.isArray(traitSkill.situational) ? traitSkill.situational : []);

    // Ensure a subtype row exists for any Craft/Perform/Profession-specific
    // structured bonus so the bonus has somewhere to land (Gnome "+2 Craft
    // (alchemy)"); reconcile auto-created rows when their source is removed.
    const directBonusKeys = new Set();
    [raceSkill, tmplSkill, featSkill, classSkill, bloodlineSkill, traitSkill].forEach((s) => {
      if (s && s.direct) Object.keys(s.direct).forEach((k) => directBonusKeys.add(k));
    });
    syncBonusSubtypes(directBonusKeys);

    // First pass: gather all skill ranks for synergy calculation
    const rankMap = {};
    $$("#skills-body-left tr, #skills-body-right tr").forEach((row) => {
      if (row.classList.contains("subtype-header-row") || row.classList.contains("skill-notes-row-container")) return;
      const ranks = parseFloat(row.querySelector(".skill-ranks")?.value) || 0;
      if (ranks <= 0) return;

      const skillName = getRowSkillName(row);
      if (skillName) {
        // Store the highest rank for this base skill name (for synergy checks)
        if (!rankMap[skillName] || ranks > rankMap[skillName]) {
          rankMap[skillName] = ranks;
        }
        // For Craft, also store generic "Craft" key
        const baseName = row.dataset.subtypeOf;
        if (baseName && baseName !== skillName) {
          if (!rankMap[baseName] || ranks > rankMap[baseName]) {
            rankMap[baseName] = ranks;
          }
        }
      }
    });

    // Also check custom skills
    $$("#custom-skills-body tr").forEach((row) => {
      const nameInput = row.querySelector(".custom-skill-name");
      const ranks = parseFloat(row.querySelector(".skill-ranks")?.value) || 0;
      if (nameInput && ranks > 0) {
        const name = nameInput.value.trim();
        if (name && (!rankMap[name] || ranks > rankMap[name])) {
          rankMap[name] = ranks;
        }
      }
    });

    // Build synergy bonus map: which skills get +2 from which sources
    // Synergies with a note are situational — they go into the skill's notes, not the total
    const synergyBonuses = {}; // { targetSkill: [{from, bonus, note, situational}] }
    DND35.synergies.forEach((syn) => {
      const fromRanks = rankMap[syn.from] || 0;
      if (fromRanks >= 5) {
        if (!synergyBonuses[syn.to]) synergyBonuses[syn.to] = [];
        synergyBonuses[syn.to].push({
          from: syn.from, bonus: 2,
          note: syn.note || "",
          situational: !!syn.note,
        });
      }
    });

    // Second pass: calculate totals
    $$("#skills-body-left tr, #skills-body-right tr").forEach((row) => {
      if (row.classList.contains("subtype-header-row") || row.classList.contains("skill-notes-row-container")) return;

      const abilityKey = row.dataset.ability;
      if (!abilityKey || abilityKey === "NONE") {
        const ranks = int(row.querySelector(".skill-ranks")?.value);
        const misc = expr(row.querySelector(".skill-misc")?.value);
        const totalEl = row.querySelector(".skill-total");
        if (totalEl) totalEl.textContent = fmt(ranks + misc);
        return;
      }

      const abilityMod = getAbilityMod(abilityKey);
      const ranks = int(row.querySelector(".skill-ranks")?.value);
      const misc = expr(row.querySelector(".skill-misc")?.value);
      const hasACP = row.dataset.acp === "true";
      const doubleACP = row.dataset.doubleAcp === "true";
      let penalty = 0;
      if (hasACP) penalty = doubleACP ? acPenalty * 2 : acPenalty;

      // Synergy bonus
      const skillName = getRowSkillName(row);
      const synergies = synergyBonuses[skillName] || [];
      // Also check base name for partial matches (e.g. "Survival" matches synergy to "Survival")
      const baseName = row.dataset.subtypeOf;
      if (baseName && baseName !== skillName) {
        const baseSyn = synergyBonuses[baseName] || [];
        baseSyn.forEach(s => {
          if (!synergies.find(x => x.from === s.from)) synergies.push(s);
        });
      }
      // Only unconditional synergies add to the total; situational ones become notes
      const unconditional = synergies.filter(s => !s.situational);
      const situational = synergies.filter(s => s.situational);
      const synergyBonus = unconditional.reduce((sum, s) => sum + s.bonus, 0);

      // Equipment skill bonuses (from worn magic items)
      const equipBonus = equipSkillBonuses[skillName] || 0;
      // Item Familiar skill bonuses (lowercased lookup).
      const ifamBonus = itemFamiliarSkillBonuses[(skillName || "").toLowerCase()] || 0;
      // Bloodline DIRECT skill bonus (unconditional). Match the full skill
      // name, and — for subtype rows (Perform) — the base name too, so a
      // "+2 on Perform checks" trait reaches every Perform subtype. The
      // two keys never collide (full vs base), so summing can't double-count.
      const blKey = (skillName || "").toLowerCase();
      const blBaseKey = (baseName && baseName !== skillName)
        ? baseName.toLowerCase() : null;
      const bloodlineBonus = (bloodlineSkill.direct[blKey] || 0)
        + (blBaseKey ? (bloodlineSkill.direct[blBaseKey] || 0) : 0);
      // Size modifier — Hide only. Can be negative (Large+ creatures).
      const sizeBonus = (skillName === "Hide") ? hideSizeMod : 0;
      // Racial / template DIRECT skill bonuses. Match the full skill name
      // (blKey) and — like bloodline — the subtype base (blBaseKey), plus the
      // global all-skills bonus. raceBonus can be negative (e.g. a -2 racial).
      const raceBonus = (raceSkill.direct[blKey] || 0)
        + (blBaseKey ? (raceSkill.direct[blBaseKey] || 0) : 0) + (raceSkill.global || 0);
      const tmplBonus = (tmplSkill.direct[blKey] || 0)
        + (blBaseKey ? (tmplSkill.direct[blBaseKey] || 0) : 0) + (tmplSkill.global || 0);
      const featBonus = (featSkill.direct[blKey] || 0)
        + (blBaseKey ? (featSkill.direct[blBaseKey] || 0) : 0);
      // Class-feature skill bonuses (Druid Nature Sense, …), untyped.
      const classBonus = (classSkill.direct[blKey] || 0)
        + (blBaseKey ? (classSkill.direct[blBaseKey] || 0) : 0) + (classSkill.global || 0);
      // UA trait/flaw skill bonuses — full name + subtype-base match, untyped.
      const traitBonus = (traitSkill.direct[blKey] || 0)
        + (blBaseKey ? (traitSkill.direct[blBaseKey] || 0) : 0) + (traitSkill.global || 0);
      // Split for LABELLING only — the total above already counts both. A
      // trait's +1 and a flaw's -4 are different sources and must not be
      // chipped as one "-3 trait". Falls back to a single combined chip if
      // the picker predates the byKind split.
      const traitKindBonus = (kind) => {
        const b = traitSkill.byKind && traitSkill.byKind[kind];
        if (!b) return null;
        return (b.direct[blKey] || 0)
          + (blBaseKey ? (b.direct[blBaseKey] || 0) : 0) + (b.global || 0);
      };
      const traitOnly = traitKindBonus("trait");
      const flawOnly  = traitKindBonus("flaw");

      const total = abilityMod + ranks + misc + penalty + synergyBonus
        + equipBonus + ifamBonus + bloodlineBonus + sizeBonus + raceBonus + tmplBonus
        + featBonus + classBonus + traitBonus;
      const abilityModEl = row.querySelector(".skill-ability-mod");
      if (abilityModEl) abilityModEl.textContent = fmt(abilityMod);
      const totalEl = row.querySelector(".skill-total");
      if (totalEl) {
        // Trained-only skills with 0 ranks: show "NR" (Not Ranked /
        // cannot be used) instead of a numeric total. Look up the
        // base skill's `untrained` flag from DND35.skills via the
        // row's skill name (or subtype-base name for subtypes).
        const baseSkillName = row.dataset.subtypeOf || skillName;
        const baseSkill = DND35.skills.find(s => s.name === baseSkillName);
        const trainedOnly = baseSkill && baseSkill.untrained === false;
        totalEl.textContent = (trainedOnly && ranks === 0) ? "NR" : fmt(total);
      }

      // Source chips for every bonus folded into the total that ISN'T one of
      // the three boxes the player can see and edit (ranks / ability mod /
      // misc). Anything else arriving silently means the displayed total
      // can't be reconciled by hand — which is the whole complaint. Every
      // addend in `total` above needs a chip here; if you add a source to
      // that sum, add it to this list too.
      const synInfoEl = row.querySelector(".synergy-info");
      if (synInfoEl) {
        const badges = [];
        // Signed so a PENALTY is as visible as a bonus (traits and flaws,
        // racial -2s, and Large-creature Hide all go negative).
        const chip = (amount, label, rgb, title) => {
          if (!amount) return;
          badges.push(
            `<span class="synergy-badge" style="background:rgba(${rgb},0.16);` +
            `border-color:rgba(${rgb},0.5)" title="${escapeAttrSk(title)}">` +
            `${amount > 0 ? "+" : ""}${amount} ${label}</span>`);
        };
        for (const s of unconditional) {
          badges.push(`<span class="synergy-badge" title="${s.from}: +${s.bonus}">+${s.bonus} ${s.from}</span>`);
        }
        chip(ifamBonus, "item familiar", "180,140,230",
             "Item familiar bonus (UA): bypasses the max-ranks cap");
        chip(bloodlineBonus, "bloodline", "200,140,60",
             "Bloodline skill bonus (UA Bloodlines)");
        chip(sizeBonus, "size", "120,170,210",
             `Size modifier to Hide (${charSize})`);
        chip(raceBonus, "race", "110,180,120", "Racial skill bonus");
        chip(tmplBonus, "template", "180,150,210", "Template skill bonus");
        // These four were reaching the total with no chip at all.
        chip(equipBonus, "equipment", "150,170,190",
             "Skill bonus from a worn magic item");
        chip(featBonus, "feat", "200,161,74",
             "Skill bonus granted by a feat");
        chip(classBonus, "class", "160,190,120",
             "Skill bonus from a class feature");
        if (traitOnly === null) {
          chip(traitBonus, "trait", "190,130,160",
               "Skill bonus from a UA trait or flaw");
        } else {
          chip(traitOnly, "trait", "110,180,120",
               "Skill modifier from a UA trait");
          chip(flawOnly, "flaw", "190,120,150",
               "Skill modifier from a UA flaw");
        }
        synInfoEl.innerHTML = badges.join("");
      }

      // Auto-populate situational synergies into the skill's notes
      const toggleBtn = row.querySelector(".skill-notes-toggle");
      if (toggleBtn) {
        // Rank-based synergy notes stay in rankSynergy on their own —
        // updateClassFeatureSynergies (Spellcraft specialty-school) reads
        // it and must not pick up the bloodline affinity note.
        const rankSyn = situational.length > 0
          ? situational.map(s => `+${s.bonus} ${s.note} (${s.from} synergy)`).join("; ")
          : "";
        toggleBtn.dataset.rankSynergy = rankSyn;
        // Bloodline AFFINITY: situational social bonus vs creatures of a
        // bloodline — a note on the 5 social skills, NEVER added to the total.
        // One note per bloodline whose affinity covers this skill (each is a
        // separate, non-overlapping condition vs its own creature type).
        const parts = [rankSyn];
        for (const aff of bloodlineAffinities) {
          const affSkills = aff.skills.map(s => s.toLowerCase());
          if (affSkills.includes(blKey)
              || (blBaseKey && affSkills.includes(blBaseKey))) {
            parts.push(`+${aff.value} vs ${aff.vs} (bloodline affinity)`);
          }
        }
        // Racial / template SITUATIONAL (conditional) skill bonuses → notes,
        // never added to the total (same treatment as the bloodline affinity
        // above). Match the full skill name or its subtype base, so a "Craft"
        // restriction note lands on every Craft subtype row.
        for (const sit of racialSituational) {
          const sl = String(sit.skill || "").toLowerCase();
          if (sl === blKey || (blBaseKey && sl === blBaseKey)) {
            const sign = sit.amount > 0 ? "+" : "";
            // Surface the bonus TYPE (what stacks) + the SOURCE (which
            // feat/race/template/trait granted it). Type omitted when
            // untyped; source falls back to "conditional" when unknown.
            const ty = (sit.category && String(sit.category).toLowerCase() !== "untyped")
              ? `${sit.category} ` : "";
            const src = sit.source || "conditional";
            parts.push(`${sign}${sit.amount} ${ty}${sit.condition} (${src})`);
          }
        }
        const synNotes = parts.filter(Boolean).join("; ");
        toggleBtn.dataset.synergy = synNotes;
        toggleBtn.classList.toggle("has-notes", !!synNotes || !!toggleBtn.dataset.notes);
        // If this skill's notes row is already open, refresh the visible
        // situational-note div so the affinity note appears live.
        const nextRow = row.nextElementSibling;
        if (nextRow && nextRow.classList.contains("skill-notes-row-container")) {
          const synDiv = nextRow.querySelector(".synergy-notes");
          if (synDiv) {
            synDiv.textContent = synNotes;
            synDiv.style.display = synNotes ? "" : "none";
          }
        }
      }
    });

    // Custom skills
    $$("#custom-skills-body tr").forEach((row) => {
      const select = row.querySelector(".custom-skill-ability");
      const abilityKey = select?.value;
      const ranks = int(row.querySelector(".skill-ranks")?.value);
      const misc = expr(row.querySelector(".skill-misc")?.value);
      let abilityMod = 0;
      if (abilityKey && abilityKey !== "NONE") {
        abilityMod = getAbilityMod(abilityKey);
      }
      const total = abilityMod + ranks + misc;
      const abilityModEl = row.querySelector(".skill-ability-mod");
      if (abilityModEl) abilityModEl.textContent = fmt(abilityMod);
      const totalEl = row.querySelector(".skill-total");
      if (totalEl) totalEl.textContent = fmt(total);
    });

    // Class feature synergies (not skills, so handled separately)
    updateClassFeatureSynergies(rankMap);
  }

  // Attribute-safe escape for chip tooltips. The strings are ours today,
  // but charSize comes off a form control, and a title="" is exactly the
  // place an unescaped quote silently breaks the surrounding markup.
  function escapeAttrSk(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // Turning feats that earn a recognition chip in the Turn/Rebuke section.
  // Matched by name via Feats.hasFeat; extensible (add Improved Turning,
  // Extra Turning, Sacred Boost, … here as needed).
  const TURN_FEATS = [
    { name: "Empower Turning", label: "Empower Turning",
      effect: "×1.5 turning damage (after adding level + Cha)" },
  ];

  function renderTurnFeatChips() {
    const host = $("#turn-feat-chips");
    if (!host) return;
    const has = (typeof Feats !== "undefined" && Feats.hasFeat)
      ? Feats.hasFeat : () => false;
    const chips = TURN_FEATS.filter(f => has(f.name));
    // Static, trusted label/effect strings (no user input) — safe to inline.
    host.innerHTML = chips.map(f =>
      `<span class="turn-feat-chip" title="${f.effect}">` +
      `<span class="turn-feat-chip-name">${f.label}</span>` +
      `<span class="turn-feat-chip-eff">${f.effect}</span></span>`
    ).join("");
    host.style.display = chips.length ? "" : "none";
  }

  function updateClassFeatureSynergies(rankMap) {
    // Turn/Rebuke Undead from Knowledge (Religion) 5+ ranks
    const turnEl = $("#turn-synergy-note");
    if (turnEl) {
      if ((rankMap["Knowledge (Religion)"] || 0) >= 5) {
        turnEl.textContent = "+2 turning check (Knowledge: Religion synergy)";
        turnEl.style.display = "";
      } else {
        turnEl.style.display = "none";
      }
    }

    // Turning-feat recognition: render a read-only chip for each turning feat
    // the character has (Empower Turning today; the table is extensible). Runs
    // here because updateClassFeatureSynergies already owns the Turn/Rebuke
    // section and re-runs on recalcAll (which fires on Feats-tab edits).
    renderTurnFeatChips();

    // Spellcraft note from Wizard Specialty School (now per-caster in spells tab)
    const schools = [];
    $$(".sc-specialist-toggle").forEach(toggle => {
      if (!toggle.checked) return;
      const panel = toggle.closest(".inner-tab-content");
      const school = (panel?.querySelector(".sc-specialty-school")?.value || "").trim();
      if (school) schools.push(school);
    });
    const spellcraftRow = findSkillRow("Spellcraft");
    if (spellcraftRow) {
      const toggleBtn = spellcraftRow.querySelector(".skill-notes-toggle");
      if (toggleBtn) {
        const rankSynergy = toggleBtn.dataset.rankSynergy || "";
        const schoolNote = schools.map(s => `+2 on Spellcraft checks for ${s} spells (Wizard Specialty)`).join("; ");
        const parts = [rankSynergy, schoolNote].filter(Boolean);
        toggleBtn.dataset.synergy = parts.join("; ");
        toggleBtn.classList.toggle("has-notes", parts.length > 0 || !!toggleBtn.dataset.notes);

        const nextRow = spellcraftRow.nextElementSibling;
        if (nextRow && nextRow.classList.contains("skill-notes-row-container")) {
          const synDiv = nextRow.querySelector(".synergy-notes");
          if (synDiv) {
            synDiv.textContent = toggleBtn.dataset.synergy;
            synDiv.style.display = toggleBtn.dataset.synergy ? "" : "none";
          } else if (toggleBtn.dataset.synergy) {
            const div = document.createElement("div");
            div.className = "synergy-notes";
            div.textContent = toggleBtn.dataset.synergy;
            nextRow.querySelector(".skill-notes-row").prepend(div);
          }
        }
      }
    }
  }

  function findSkillRow(skillName) {
    let found = null;
    $$("#skills-body-left tr, #skills-body-right tr").forEach((row) => {
      if (found) return;
      if (row.classList.contains("subtype-header-row") || row.classList.contains("skill-notes-row-container")) return;
      if (getRowSkillName(row) === skillName) found = row;
    });
    return found;
  }

  function getRowSkillName(row) {
    // For subtype rows: "Craft (Weaponsmithing)"
    const subtypeInput = row.querySelector(".skill-subtype-input");
    if (subtypeInput) {
      const baseName = row.dataset.subtypeOf || "";
      const sub = subtypeInput.value.trim();
      return sub ? `${baseName} (${sub})` : baseName;
    }
    // For Knowledge rows with fixed subtypes
    const nameSpan = row.querySelector(".skill-name");
    if (nameSpan) return nameSpan.textContent.trim();
    return "";
  }

  // ============================================================
  // Collect / Load skill data for save/load
  // ============================================================
  function collectData() {
    const skills = [];
    $$("#skills-body-left tr, #skills-body-right tr").forEach((row) => {
      if (row.classList.contains("skill-notes-row-container")) return;
      if (row.classList.contains("subtype-header-row")) {
        skills.push({ type: "header", baseName: row.dataset.subtypeBase, index: int(row.dataset.skillIndex) });
        return;
      }
      const isSub = row.dataset.isSubtype === "true";
      const entry = {
        type: isSub ? "subtype" : "skill",
        classSkill: row.querySelector(".skill-class-check")?.checked || false,
        ranks: row.querySelector(".skill-ranks")?.value || "0",
        misc: row.querySelector(".skill-misc")?.value || "0",
        index: int(row.dataset.skillIndex),
      };
      const subtypeInput = row.querySelector(".skill-subtype-input");
      if (isSub) {
        // Subtype rows key to their editable group by base name (Craft/
        // Perform/Profession) so the group survives an array reorder.
        entry.baseName = row.dataset.subtypeOf || "";
        if (subtypeInput) entry.subtypeName = subtypeInput.value;
      } else {
        // Regular / Knowledge rows key by display name ("Knowledge
        // (Arcana)"), making load order-independent (see LEGACY_SKILL_ORDER).
        entry.name = getRowSkillName(row);
        if (subtypeInput) entry.subtypeName = subtypeInput.value;
      }
      // Notes
      const toggleBtn = row.querySelector(".skill-notes-toggle");
      if (toggleBtn?.dataset.notes) entry.notes = toggleBtn.dataset.notes;
      skills.push(entry);
    });
    return skills;
  }

  function loadData(skillsData, getAbilityMod) {
    if (!skillsData || !Array.isArray(skillsData)) {
      // Legacy format: array of {classSkill, ranks, misc, subtype?}
      if (skillsData && Array.isArray(skillsData)) {
        loadLegacyData(skillsData, getAbilityMod);
      }
      return;
    }

    const tbodyL = $("#skills-body-left");
    const tbodyR = $("#skills-body-right");
    tbodyL.innerHTML = "";
    tbodyR.innerHTML = "";

    const midpoint = Math.ceil(DND35.skills.length / 2);

    // Resolve each saved entry to a target skill BY NAME (order-independent),
    // falling back to LEGACY_SKILL_ORDER[index] for pre-name-keyed saves.
    // This lets DND35.skills be reordered (e.g. alphabetized) without
    // breaking existing saves — see LEGACY_SKILL_ORDER above.
    const targetName = (entry) => {
      if (entry.name != null) return entry.name;          // regular skill (new)
      if (entry.baseName != null) return entry.baseName;  // subtype / header (new)
      return LEGACY_SKILL_ORDER[entry.index];             // legacy index fallback
    };
    const skillByName = {};      // "Knowledge (Arcana)" -> skill entry
    const subtypesByBase = {};   // "Craft" -> [subtype entries]
    skillsData.forEach((entry) => {
      const nm = targetName(entry);
      if (nm == null) return;
      if (entry.type === "subtype") (subtypesByBase[nm] = subtypesByBase[nm] || []).push(entry);
      else if (entry.type === "skill") skillByName[nm] = entry;
      // headers are implicit (always recreated); nothing to store.
    });

    // Walk every DND35.skills entry in order. Use saved data when present,
    // otherwise create the skill with defaults. This prevents partial
    // imports (e.g. from PDF) from deleting skills that weren't in the
    // source, while keeping the correct display order.
    DND35.skills.forEach((skill, i) => {
      const tbody = i < midpoint ? tbodyL : tbodyR;
      const dispName = (skill.hasSubtype && skill.subtypeLabel)
        ? `${skill.name} (${skill.subtypeLabel})` : skill.name;

      if (skill.editableSubtype) {
        // Subtype group (Craft, Perform, Profession)
        const subtypes = subtypesByBase[skill.name] || [];
        // Always create the header row
        const headerTr = document.createElement("tr");
        headerTr.className = "subtype-header-row";
        headerTr.dataset.subtypeBase = skill.name;
        headerTr.dataset.skillIndex = i;
        headerTr.innerHTML = `
          <td colspan="7" style="padding:0.3rem 0.25rem 0.1rem">
            <span style="font-weight:600;font-size:0.8rem;">${skill.name}</span>
            <span class="skill-untrained-marker">${skill.untrained ? "U" : ""}</span>
            <button class="btn-add-subtype" data-skill-name="${skill.name}" data-skill-index="${i}">+ add subtype</button>
          </td>
        `;
        tbody.appendChild(headerTr);
        headerTr.querySelector(".btn-add-subtype").addEventListener("click", () => {
          addSubtypeEntry(tbody, skill, i, "");
        });
        // Add saved subtypes, or one empty default if none saved
        if (subtypes.length > 0) {
          subtypes.forEach((entry) => {
            const tr = addSubtypeEntry(tbody, skill, i, entry.subtypeName || "", entry);
            if (entry.notes) {
              const toggleBtn = tr.querySelector(".skill-notes-toggle");
              toggleBtn.dataset.notes = entry.notes;
              toggleBtn.classList.add("has-notes");
            }
          });
        } else {
          addSubtypeEntry(tbody, skill, i, "");
        }
      } else {
        // Regular skill — matched by display name.
        const entry = skillByName[dispName];
        const tr = addSkillRow(tbody, skill, i, getAbilityMod);
        if (entry) {
          tr.querySelector(".skill-class-check").checked = entry.classSkill;
          tr.querySelector(".skill-ranks").value = entry.ranks;
          tr.querySelector(".skill-misc").value = entry.misc;
          if (entry.notes) {
            const toggleBtn = tr.querySelector(".skill-notes-toggle");
            toggleBtn.dataset.notes = entry.notes;
            toggleBtn.classList.add("has-notes");
          }
        }
      }
    });

    tbodyL.addEventListener("input", () => recalc(getAbilityMod));
    tbodyR.addEventListener("input", () => recalc(getAbilityMod));
    recalc(getAbilityMod);
  }

  function loadLegacyData(skillsData, getAbilityMod) {
    // Old format: simple array matching DND35.skills order
    const rows = $$("#skills-body-left tr:not(.subtype-header-row):not(.skill-notes-row-container), #skills-body-right tr:not(.subtype-header-row):not(.skill-notes-row-container)");
    let rowIdx = 0;
    skillsData.forEach((skill, i) => {
      if (rows[rowIdx]) {
        rows[rowIdx].querySelector(".skill-class-check").checked = skill.classSkill;
        rows[rowIdx].querySelector(".skill-ranks").value = skill.ranks;
        rows[rowIdx].querySelector(".skill-misc").value = skill.misc;
        const subtypeInput = rows[rowIdx].querySelector(".skill-subtype-input");
        if (subtypeInput && skill.subtype) subtypeInput.value = skill.subtype;
        rowIdx++;
      }
    });
    recalc(getAbilityMod);
  }

  // ============================================================
  // Custom Skills (unchanged from app.js, just moved here)
  // ============================================================
  let customSkillCount = 0;

  function addCustomSkill(data = {}) {
    const tbody = $("#custom-skills-body");
    const tr = document.createElement("tr");
    tr.dataset.customIndex = customSkillCount++;
    tr.innerHTML = `
      <td class="skill-class-col"><input type="checkbox" class="skill-class-check"></td>
      <td class="skill-name-col"><input type="text" class="custom-skill-name" placeholder="Skill name" value="${data.name || ""}"></td>
      <td class="skill-ability-col">
        <select class="custom-skill-ability">
          <option value="NONE">--</option>
          <option value="STR">STR</option>
          <option value="DEX">DEX</option>
          <option value="CON">CON</option>
          <option value="INT">INT</option>
          <option value="WIS">WIS</option>
          <option value="CHA">CHA</option>
        </select>
      </td>
      <td class="skill-total-col"><span class="skill-total calc-field">+0</span></td>
      <td class="skill-ability-mod-col"><span class="skill-ability-mod">+0</span></td>
      <td class="skill-ranks-col"><input type="number" class="skill-ranks" value="${data.ranks || 0}" min="0" step="0.5"></td>
      <td class="skill-misc-col"><input type="text" class="skill-misc" value="${data.misc || 0}"></td>
    `;
    tbody.appendChild(tr);
    if (data.classSkill) tr.querySelector(".skill-class-check").checked = true;
    if (data.ability) tr.querySelector(".custom-skill-ability").value = data.ability;
    return tr;
  }

  function collectCustomSkills() {
    const customs = [];
    $$("#custom-skills-body tr").forEach((row) => {
      customs.push({
        classSkill: row.querySelector(".skill-class-check").checked,
        name: row.querySelector(".custom-skill-name").value,
        ability: row.querySelector(".custom-skill-ability").value,
        ranks: row.querySelector(".skill-ranks").value,
        misc: row.querySelector(".skill-misc").value,
      });
    });
    return customs;
  }

  function loadCustomSkills(data, getAbilityMod) {
    $("#custom-skills-body").innerHTML = "";
    customSkillCount = 0;
    if (data) {
      data.forEach((cs) => {
        const tr = addCustomSkill(cs);
        tr.addEventListener("input", () => recalc(getAbilityMod));
      });
    }
  }

  function resetCustomSkills() {
    $("#custom-skills-body").innerHTML = "";
    customSkillCount = 0;
  }

  // ============================================================
  // Get total ranks for a skill by display name (e.g. "Knowledge (Religion)")
  // ============================================================
  function getRanks(skillName) {
    let max = 0;
    $$("#skills-body-left tr, #skills-body-right tr").forEach((row) => {
      if (row.classList.contains("subtype-header-row") || row.classList.contains("skill-notes-row-container")) return;
      const name = getRowSkillName(row);
      if (name === skillName) {
        const r = parseFloat(row.querySelector(".skill-ranks")?.value) || 0;
        if (r > max) max = r;
      }
    });
    return max;
  }

  // ============================================================
  // Public API
  // ============================================================
  return {
    build,
    recalc,
    collectData,
    loadData,
    addCustomSkill,
    collectCustomSkills,
    loadCustomSkills,
    resetCustomSkills,
    removeSubtype,
    getRanks,
  };
})();
