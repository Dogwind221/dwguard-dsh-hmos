// Registration test: the real `defineTool` must accept every definition, and
// apply() must wire the six tools, three skills and one prompt section.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, inject, name } from '../lib/index.js';

function fakeContext() {
  const registered = [];
  const skills = [];
  const sections = [];
  const disposers = [];
  const ctx = {
    tools: { register: (tool) => registered.push(tool) },
    get: (key) => {
      if (key === 'skills') {
        return {
          register: (skill) => {
            skills.push(skill);
            return () => {};
          }
        };
      }
      if (key === 'systemPrompt') {
        return {
          section: (section) => {
            sections.push(section);
            return () => {};
          },
          getSectionOrder: (orderName) => (orderName === 'TEAM_POLICY' ? 600 : 0)
        };
      }
      return undefined;
    },
    effect: (body) => {
      const dispose = body();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    logger: { error: (message) => assert.fail(message), warn: (message) => assert.fail(message) }
  };
  return { ctx, registered, skills, sections, disposers };
}

test('the plugin declares its identity and injection', () => {
  assert.equal(name, 'dwguard-hmos');
  assert.deepEqual(inject, ['tools']);
});

test('apply registers twelve tools, three skills and one policy section', () => {
  const { ctx, registered, skills, sections, disposers } = fakeContext();
  apply(ctx, {});

  assert.deepEqual(registered.map((tool) => tool.name).sort(), [
    'dwguard_audit',
    'dwguard_audit_dimension',
    'dwguard_calibration',
    'dwguard_confirm',
    'dwguard_dispatch',
    'dwguard_knowledge',
    'dwguard_prereview',
    'dwguard_rules',
    'dwguard_scan',
    'dwguard_shadow',
    'dwguard_spec',
    'dwguard_status'
  ]);
  assert.equal(skills.length, 3);
  assert.deepEqual(skills.map((skill) => skill.name).sort(), [
    'dwguard-hmos',
    'hmos-acceptance-rubric',
    'hmos-audit-playbook'
  ]);
  for (const skill of skills) {
    assert.ok(skill.content.length > 1500, `${skill.name} 的正文应从 skills/*.md 加载`);
    assert.ok(skill.description.length > 20);
  }

  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'dwguard:policy');
  assert.equal(sections[0].order, 600);
  assert.match(sections[0].text, /不写应用代码/);

  assert.equal(disposers.length, 2);
  for (const dispose of disposers) dispose();
});

test('every tool exposes a canonical output schema and a renderer', () => {
  const { ctx, registered } = fakeContext();
  apply(ctx, {});
  for (const tool of registered) {
    assert.equal(typeof tool.execute, 'function', tool.name);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.length > 40, `${tool.name} 的描述太短`);
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(tool.output.schema.additionalProperties, false);
    assert.equal(typeof tool.output.render, 'function');
  }
});
