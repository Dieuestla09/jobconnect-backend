const test = require('node:test');
const assert = require('node:assert/strict');
const { scoreJob, splitRequirements, meaningfulWords, locationFit } = require('../../services/matchScore');

const frontendJob = {
  requirements: 'React, JavaScript, HTML, CSS, REST API experience.',
  location: 'Kampala, Uganda',
  job_type: 'Full-time'
};

test('splitRequirements splits on commas, newlines, "and" and drops duplicates', () => {
  assert.deepEqual(splitRequirements('React, JavaScript, HTML, CSS, REST API experience.'), [
    'React',
    'JavaScript',
    'HTML',
    'CSS',
    'REST API experience'
  ]);
  assert.deepEqual(splitRequirements('Node.js and Express\n- Git\nreact, React'), ['Node.js', 'Express', 'Git', 'react']);
  assert.deepEqual(splitRequirements(''), []);
  assert.deepEqual(splitRequirements(null), []);
});

test('meaningfulWords removes filler and normalises plurals and aliases', () => {
  assert.deepEqual(meaningfulWords('REST API experience'), ['rest', 'api']);
  assert.deepEqual(meaningfulWords('REST APIs'), ['rest', 'api']);
  assert.deepEqual(meaningfulWords('Node.js'), ['node']);
  assert.deepEqual(meaningfulWords('C++ and C#'), ['c++', 'c#']);
});

test('a perfect profile scores 100', () => {
  const result = scoreJob(
    { skills: 'React, JavaScript, HTML, CSS, REST APIs', location: 'Kampala, Uganda' },
    frontendJob
  );
  assert.equal(result.score, 100);
  assert.equal(result.skills.coverage, 100);
  assert.deepEqual(result.skills.missing, []);
});

test('score is 70% skills + 30% location and lists matched vs missing skills', () => {
  // 3 of 5 requirements covered (React, JavaScript, REST API) -> 60% * 0.7 = 42; same city -> 30.
  const result = scoreJob(
    { skills: 'React, JavaScript, Bootstrap, REST APIs', location: 'Kampala, Uganda' },
    frontendJob
  );
  assert.deepEqual(result.skills.matched, ['React', 'JavaScript', 'REST API experience']);
  assert.deepEqual(result.skills.missing, ['HTML', 'CSS']);
  assert.equal(result.breakdown.skillsPoints, 42);
  assert.equal(result.breakdown.locationPoints, 30);
  assert.equal(result.score, 72);
});

test('a requirement is covered only if MORE than half of its words match', () => {
  const job = { requirements: 'REST API design, Java', location: 'Remote', job_type: 'Remote' };
  // "REST API design": 2 of 3 words -> covered. "Java" must NOT be matched by "JavaScript".
  const result = scoreJob({ skills: 'REST API, JavaScript', location: '' }, job);
  assert.deepEqual(result.skills.matched, ['REST API design']);
  assert.deepEqual(result.skills.missing, ['Java']);

  // Exactly half (1 of 2 words) is NOT enough.
  const half = scoreJob({ skills: 'Customer' }, { requirements: 'Customer support', location: 'x', job_type: 'Full-time' });
  assert.deepEqual(half.skills.matched, []);
  assert.deepEqual(half.skills.missing, ['Customer support']);
});

test('filler words such as "experience" and "strong" never create a match', () => {
  const result = scoreJob(
    { skills: 'experience, strong, skills' },
    { requirements: 'Strong communication, Excel experience', location: 'Kampala, Uganda', job_type: 'Full-time' }
  );
  assert.equal(result.skills.coverage, 0);
  assert.equal(result.skills.missing.length, 2);
});

test('location: remote = 100, same city = 100, same country = 50, otherwise 0', () => {
  assert.equal(locationFit('Jinja, Uganda', { location: 'Anywhere', job_type: 'Remote' }).points, 100);
  assert.equal(locationFit('Kampala, Uganda', { location: 'Kampala, Uganda', job_type: 'Full-time' }).points, 100);
  assert.equal(locationFit('Jinja, Uganda', { location: 'Kampala, Uganda', job_type: 'Full-time' }).points, 50);
  assert.equal(locationFit('Nairobi, Kenya', { location: 'Kampala, Uganda', job_type: 'Full-time' }).points, 0);
  assert.equal(locationFit('', { location: 'Kampala, Uganda', job_type: 'Full-time' }).points, 0);
});

test('missing profile or missing requirements do not crash and are explained', () => {
  const noProfile = scoreJob(null, frontendJob);
  assert.equal(noProfile.skills.coverage, 0);
  assert.equal(noProfile.skills.missing.length, 5);
  assert.equal(noProfile.score, 0);

  const noRequirements = scoreJob({ skills: 'React', location: 'Kampala, Uganda' }, { requirements: '', location: 'Kampala, Uganda', job_type: 'Full-time' });
  assert.equal(noRequirements.score, 30);
  assert.match(noRequirements.skills.note, /not listed requirements/);
});

test('score is always an integer between 0 and 100', () => {
  const skills = ['', 'React', 'x'.repeat(5000), 'C++, C#, R'];
  for (const s of skills) {
    const result = scoreJob({ skills: s, location: 'Kampala' }, frontendJob);
    assert.ok(Number.isInteger(result.score) && result.score >= 0 && result.score <= 100);
  }
});
