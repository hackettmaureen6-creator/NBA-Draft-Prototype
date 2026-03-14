#!/usr/bin/env node
'use strict';

/**
 * parseRealGmPicks.js
 *
 * Reads realgm_picks_full.txt (scraped from RealGM "NBA Future Draft Picks By Team"),
 * parses it into per-pick JSON objects matching pick_schema_example.json, and
 * writes the result array to stdout.
 *
 * Usage:
 *   node parseRealGmPicks.js > all_teams_draft_picks_from_realgm.json
 *
 * Any pick whose text is ambiguous gets needsReview: true so you can audit it.
 *
 * ─── File structure (after scrape noise is stripped) ────────────────────────
 *
 *   {TeamName} Future NBA Draft Picks       ← section header
 *   Year                                    ← repeated column header (skip)
 *   First Round                             ← repeated column header (skip)
 *   Second Round                            ← repeated column header (skip)
 *   2026                                    ← year line
 *   <first-round description text...>
 *   <COUNT>                                 ← standalone digit(s), e.g. "1", "0", "1+1"
 *   <second-round description text...>
 *   <COUNT>
 *   2027
 *   ...
 */

const fs   = require('fs');
const path = require('path');

// ─── Team full name → 3-letter abbreviation ───────────────────────────────
const TEAM_NAME_TO_ABBR = {
  'Atlanta Hawks':           'ATL',
  'Boston Celtics':          'BOS',
  'Brooklyn Nets':           'BRK',
  'Charlotte Hornets':       'CHA',
  'Chicago Bulls':           'CHI',
  'Cleveland Cavaliers':     'CLE',
  'Dallas Mavericks':        'DAL',
  'Denver Nuggets':          'DEN',
  'Detroit Pistons':         'DET',
  'Golden State Warriors':   'GOS',
  'Houston Rockets':         'HOU',
  'Indiana Pacers':          'IND',
  'Los Angeles Clippers':    'LAC',
  'Los Angeles Lakers':      'LAL',
  'Memphis Grizzlies':       'MEM',
  'Miami Heat':              'MIA',
  'Milwaukee Bucks':         'MIL',
  'Minnesota Timberwolves':  'MIN',
  'New Orleans Pelicans':    'NOP',
  'New York Knicks':         'NYK',
  'Oklahoma City Thunder':   'OKC',
  'Orlando Magic':           'ORL',
  'Philadelphia 76ers':      'PHL',
  'Phoenix Suns':            'PHX',
  'Portland Trail Blazers':  'POR',
  'Sacramento Kings':        'SAC',
  'San Antonio Spurs':       'SAN',
  'Toronto Raptors':         'TOR',
  'Utah Jazz':               'UTH',
  'Washington Wizards':      'WAS',
};

// ─── Lines to strip from the scrape (navigation, ads, repeated headers) ───
const SKIP_PATTERNS = [
  /^\(https?:\/\//,
  /^\(\/nba/,
  /^ads by a n t e n g o/i,
  /^×$/,
  /^Leagues[▾]?$/,
  /^NBA Forums[▾]?$/,
  /^News[▾]?$/,
  /^Teams[▾]?$/,
  /^Transactions[▾]?$/,
  /^Stats[▾]?$/,
  /^Games[▾]?$/,
  /^Players[▾]/,
  /^Draft[▾]?$/,
  /^Events[▾]/,
  /^Tickets/,
  /^Trade$/,
  /^Checker$/,
  /^eagues\)/,
  /^ards\/viewforum/,
  /^basketball\/\?wsUser/,
  /^Betting/,
  /^etting\//,
  /^NEW$/,
  /^NBA Draft \(/,
  /^Draft Simulator/,
  /^News \(/,
  /^Prospects \(/,
  /^Special Events/,
  /^Future Drafts$/,
  /^▾ Draft History/,
  /^Forums \(/,
  /^NBA Future Draft/i,
  /^Year$/,
  /^First Round$/,
  /^Second Round$/,
  /^\(\/\)$/,
  /^Events \(/,
];

function shouldSkip(line) {
  const t = line.trim();
  return t === '' ? false : SKIP_PATTERNS.some(p => p.test(t));
}

// ─── Is a line a standalone pick-count? ───────────────────────────────────
// Matches: "0", "1", "2", "1+1", "2+1", "3+1", "1+1+1" etc.
// Must NOT look like a lottery protection range ("1-8", "1-14").
const COUNT_RE = /^\d+(\+\d+)*$/;

function isCountLine(line) {
  return COUNT_RE.test(line.trim());
}

// Parse total picks from a count string ("1+1" → 2, "0" → 0, "3+1" → 4)
function parseCount(countStr) {
  return countStr.trim().split('+').reduce((sum, n) => sum + (parseInt(n, 10) || 0), 0);
}

// ─── Interpret a single round's description text ──────────────────────────
// Returns partial pick fields. Marks needsReview for anything non-trivial.
function interpret(text, teamAbbr) {
  const t = text.trim().replace(/;+$/, '').trim();

  // Empty / no text
  if (!t) {
    return { owningTeam: teamAbbr, originalTeam: teamAbbr, tradedAway: false,
             poolHolder: null, hasSwapRights: false, needsReview: false };
  }

  // Simple "Own" (with optional via-path in parens)
  if (/^own(\s*[\(\[].*[\)\]])?[;.]?$/i.test(t)) {
    return { owningTeam: teamAbbr, originalTeam: teamAbbr, tradedAway: false,
             poolHolder: null, hasSwapRights: false, needsReview: false };
  }

  // "Frozen (through …)" — team holds pick but can't trade until date
  if (/^frozen/i.test(t)) {
    return { owningTeam: teamAbbr, originalTeam: teamAbbr, tradedAway: false,
             poolHolder: null, hasSwapRights: false, needsReview: true };
  }

  // "To X" / "to X (via …)" — team traded pick to X
  const tradedTo = t.match(/^to\s+([A-Z]{2,3})\b/i);
  if (tradedTo) {
    return { owningTeam: tradedTo[1].toUpperCase(), originalTeam: teamAbbr,
             tradedAway: true, poolHolder: null, hasSwapRights: false, needsReview: false };
  }

  // Single bare team code on its own (possibly "(via …)") — incoming pick
  const singleIncoming = t.match(/^([A-Z]{2,3})(\s*[\(\[].*[\)\]])?[;.]?$/);
  if (singleIncoming) {
    return { owningTeam: teamAbbr, originalTeam: singleIncoming[1].toUpperCase(),
             tradedAway: false, poolHolder: null, hasSwapRights: false, needsReview: false };
  }

  // Anything with "swap" → swap rights involved
  const hasSwap = /\bswap\b/i.test(t);

  // Anything with "most favorable / least favorable / more favorable" → pool pick
  const hasPool = /\b(most|least|more|less)\s+favorable\b/i.test(t);

  // Anything with range-protection ("1-8", "9-30", "15-30", etc.)
  const hasProtection = /\b\d+-\d+\b/.test(t);

  return {
    owningTeam: teamAbbr,
    originalTeam: teamAbbr,
    tradedAway: false,
    poolHolder: hasPool ? teamAbbr : null,
    hasSwapRights: hasSwap,
    needsReview: true,   // complex text always flagged
    _hasProtection: hasProtection,
  };
}

// ─── Build pick objects for one year+round block ──────────────────────────
function buildPicks(season, round, descText, countStr, teamAbbr) {
  const totalPicks = parseCount(countStr);
  const type = round === 1 ? 'first' : 'second';
  const picks = [];

  const base = interpret(descText, teamAbbr);
  const multiSource = countStr.includes('+');  // "1+1" means multiple sources

  if (totalPicks === 0) {
    // Zero picks: team traded pick away (or pool pick didn't convey)
    const tradedTo = descText.trim().match(/^to\s+([A-Z]{2,3})\b/i);
    picks.push({
      season,
      round,
      overall:       null,
      owningTeam:    tradedTo ? tradedTo[1].toUpperCase() : teamAbbr,
      originalTeam:  teamAbbr,
      type,
      tradedAway:    true,
      poolHolder:    null,
      hasSwapRights: false,
      notes:         descText.trim(),
      needsReview:   !tradedTo,   // flag if we couldn't parse the destination
    });
    return picks;
  }

  for (let i = 0; i < totalPicks; i++) {
    const { _hasProtection, ...fields } = base;
    picks.push({
      season,
      round,
      overall:       null,
      owningTeam:    fields.owningTeam,
      originalTeam:  fields.originalTeam,
      type,
      tradedAway:    fields.tradedAway,
      poolHolder:    fields.poolHolder,
      hasSwapRights: fields.hasSwapRights,
      notes:         descText.trim(),
      needsReview:   fields.needsReview || totalPicks > 1 || multiSource,
    });
  }

  return picks;
}

// ─── Parse one team section into pick objects ─────────────────────────────
function parseTeamSection(teamName, sectionLines) {
  const teamAbbr = TEAM_NAME_TO_ABBR[teamName];
  if (!teamAbbr) {
    process.stderr.write(`[WARN] Unknown team name: "${teamName}" — skipping\n`);
    return [];
  }

  // Remove boilerplate lines
  const clean = sectionLines.filter(l => !shouldSkip(l));

  // Split into year blocks
  const yearBlocks = [];
  let curYear = null, curLines = [];

  for (const line of clean) {
    const ym = line.trim().match(/^(202\d|203\d)$/);
    if (ym) {
      if (curYear !== null) yearBlocks.push({ year: curYear, lines: curLines });
      curYear = parseInt(ym[1], 10);
      curLines = [];
    } else {
      if (curYear !== null) curLines.push(line);
    }
  }
  if (curYear !== null) yearBlocks.push({ year: curYear, lines: curLines });

  const picks = [];

  for (const { year, lines } of yearBlocks) {
    // Find all count-line indices within this year block
    const countIdx = lines.reduce((acc, l, i) => {
      if (isCountLine(l)) acc.push(i);
      return acc;
    }, []);

    if (countIdx.length < 2) {
      // Malformed block: can't split into two rounds cleanly
      const raw = lines.join('\n').trim();
      process.stderr.write(`[WARN] ${teamAbbr} ${year}: found ${countIdx.length} count lines (expected 2). Raw:\n${raw.slice(0, 200)}\n\n`);

      if (countIdx.length === 1) {
        // Treat what we have as 1st round
        const ci = countIdx[0];
        picks.push(...buildPicks(year, 1, lines.slice(0, ci).join('\n'), lines[ci], teamAbbr));
        // 2nd round unknown
        picks.push({
          season: year, round: 2, overall: null,
          owningTeam: teamAbbr, originalTeam: teamAbbr,
          type: 'second', tradedAway: false,
          poolHolder: null, hasSwapRights: false,
          notes: '(could not parse second round from source)',
          needsReview: true,
        });
      } else {
        // No counts at all — emit one placeholder per round
        for (const round of [1, 2]) {
          picks.push({
            season: year, round, overall: null,
            owningTeam: teamAbbr, originalTeam: teamAbbr,
            type: round === 1 ? 'first' : 'second',
            tradedAway: false, poolHolder: null, hasSwapRights: false,
            notes: raw, needsReview: true,
          });
        }
      }
      continue;
    }

    // Normal path: use first two count lines
    const [c1, c2] = countIdx;

    const firstDesc  = lines.slice(0, c1).join('\n');
    const firstCount = lines[c1].trim();
    const secondDesc = lines.slice(c1 + 1, c2).join('\n');
    const secondCount = lines[c2].trim();

    picks.push(...buildPicks(year, 1, firstDesc,  firstCount,  teamAbbr));
    picks.push(...buildPicks(year, 2, secondDesc, secondCount, teamAbbr));
  }

  return picks;
}

// ─── Main ─────────────────────────────────────────────────────────────────
const inputPath = path.join(__dirname, 'realgm_picks_full.txt');
const raw = fs.readFileSync(inputPath, 'utf8');
const lines = raw.split('\n');

// Split file into team sections
const sections = [];
let curTeamName = null, curSectionLines = [];

for (const line of lines) {
  // Matches "Atlanta Hawks Future NBA Draft Picks" etc.
  // The team name is one or more Title-Case words, no abbreviation in parens.
  const m = line.trim().match(/^([A-Z][a-z]+(?:\s+[A-Z][a-z0-9]+)*)\s+Future NBA Draft Picks$/);
  if (m) {
    if (curTeamName) sections.push({ teamName: curTeamName, lines: curSectionLines });
    curTeamName = m[1];
    curSectionLines = [];
  } else {
    if (curTeamName) curSectionLines.push(line);
  }
}
if (curTeamName) sections.push({ teamName: curTeamName, lines: curSectionLines });

const allPicks = sections.flatMap(s => parseTeamSection(s.teamName, s.lines));

// Summary to stderr so it doesn't pollute the JSON output
const needsReviewCount = allPicks.filter(p => p.needsReview).length;
process.stderr.write(`\n✓ Parsed ${allPicks.length} pick records across ${sections.length} teams\n`);
process.stderr.write(`  • ${allPicks.filter(p => !p.needsReview).length} clean (no review needed)\n`);
process.stderr.write(`  • ${needsReviewCount} flagged needsReview: true\n\n`);

console.log(JSON.stringify(allPicks, null, 2));
