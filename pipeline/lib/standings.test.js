// Focused unit tests for the fixture-aware clinch / elimination logic.
//   node --test pipeline/lib/standings.test.js
//
// The motivating case is real (World Cup 2026, Group D as of 2026-06-23): the USA on 6
// points is mathematically through because its two chasers — Australia and Paraguay —
// must still play EACH OTHER, so only one of them can reach 6. A points-only rule that
// counts chasers independently wrongly withholds the clinch; the fixture-aware rule
// awards it. The control flips only the remaining fixtures to prove the distinction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clinchFlags } from './standings.js';

const rows = (pts) => Object.entries(pts).map(([name, p]) => ({ name, pts: p }));

test('chasers who must play each other → leader is clinched', () => {
  // USA 6, Australia 3, Paraguay 3, Türkiye 0. Remaining: PAR–AUS and TUR–USA.
  const f = clinchFlags(
    rows({ USA: 6, Australia: 3, Paraguay: 3, Türkiye: 0 }),
    [{ home: 'Paraguay', away: 'Australia' }, { home: 'Türkiye', away: 'USA' }],
  );
  assert.equal(f.USA.clinchedTop2, true, 'USA finishes top 2 in every completion');
  assert.equal(f.Türkiye.eliminatedTop2, true, 'Türkiye (max 3, USA always above) cannot reach top 2');
});

test('control: same points but chasers on separate games → NOT clinched', () => {
  // Flip only the fixtures: now USA plays Australia, and Paraguay plays Türkiye, so
  // Australia AND Paraguay can both reach 6 while the USA loses.
  const f = clinchFlags(
    rows({ USA: 6, Australia: 3, Paraguay: 3, Türkiye: 0 }),
    [{ home: 'USA', away: 'Australia' }, { home: 'Paraguay', away: 'Türkiye' }],
  );
  assert.equal(f.USA.clinchedTop2, false, 'a completion exists (USA loses, both chasers win) where USA is 3rd');
});

test('only one possible chaser → clinched regardless of fixtures', () => {
  // Group A shape: Mexico 6, Korea 3, Czechia 1, South Africa 1. Only Korea can reach 6.
  const f = clinchFlags(
    rows({ Mexico: 6, Korea: 3, Czechia: 1, 'South Africa': 1 }),
    [{ home: 'Mexico', away: 'Czechia' }, { home: 'Korea', away: 'South Africa' }],
  );
  assert.equal(f.Mexico.clinchedTop2, true);
});

test('no games remaining → flags reflect the final table', () => {
  const f = clinchFlags(
    rows({ A: 9, B: 6, C: 3, D: 0 }),
    [],
  );
  assert.equal(f.A.clinchedTop2, true);
  assert.equal(f.B.clinchedTop2, true);
  assert.equal(f.C.eliminatedTop2, true);
  assert.equal(f.D.eliminatedTop2, true);
});

test('a points tie that could decide top 2 is treated as unsafe (not clinched)', () => {
  // Leader 4, two rivals 3 and 3, each rival plays a separate weakling — both can reach 6
  // while the leader (last game lost) stays 4. Leader is NOT guaranteed top 2.
  const f = clinchFlags(
    rows({ Lead: 4, R1: 3, R2: 3, Weak: 0 }),
    [{ home: 'R1', away: 'Lead' }, { home: 'R2', away: 'Weak' }],
  );
  assert.equal(f.Lead.clinchedTop2, false);
});
