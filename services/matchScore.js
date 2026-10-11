// Explainable job match score. Pure functions only: no database, no Express, easy to unit test.
//
//   score = 70% * skills coverage + 30% * location fit        (0-100, rounded)
//
// Skills coverage = (requirements covered) / (requirements listed on the job).
// A requirement is COVERED only if MORE than half of its meaningful words appear in the
// candidate's skills (so "REST API experience" is covered by "REST APIs", but "Java" is not
// covered by "JavaScript", and "Node.js, Express" does not cover "Git").

const SKILLS_WEIGHT = 0.7;
const LOCATION_WEIGHT = 0.3;

// Words that carry no skill information. "experience", "strong", "tools" etc. are filler in
// requirement lists, so they must not count towards (or against) a match.
const FILLER = new Set([
  'a', 'an', 'and', 'or', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'as', 'is', 'are',
  'be', 'we', 'you', 'your', 'our', 'etc', 'including', 'such', 'good', 'strong', 'excellent', 'great',
  'solid', 'clear', 'basic', 'basics', 'advanced', 'relevant', 'experience', 'experienced', 'skill',
  'skills', 'knowledge', 'ability', 'proficiency', 'proficient', 'understanding', 'familiarity',
  'familiar', 'working', 'work', 'using', 'use', 'year', 'years', 'tool', 'tools', 'level', 'plus'
]);

// Different spellings of the same technology should be equal.
const ALIASES = { js: 'javascript', nodejs: 'node', reactjs: 'react', expressjs: 'express', vuejs: 'vue' };

// Light plural handling: "APIs" -> "api", "reports" -> "report". Short words are left alone.
const stem = (word) => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);

// Split text into lowercase, alias-resolved, stemmed words. Keeps "c++" and "c#".
const tokenize = (text) => {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/\b(node|react|express|vue)\.js\b/g, '$1js');
  const words = cleaned.match(/[a-z0-9]+(?:[+#]+)?/g) || [];
  // Aliases are resolved before stemming, otherwise "nodejs" would lose its trailing "s".
  return words.map((word) => ALIASES[word] || stem(word));
};

// Words that actually describe a skill (filler removed, single letters only if c/r/c++/c#).
const meaningfulWords = (text) =>
  tokenize(text).filter((word) => !FILLER.has(word) && (word.length > 1 || word === 'c' || word === 'r'));

// "React, JavaScript, HTML, CSS, REST API experience." -> five requirement phrases.
const splitRequirements = (text) => {
  const seen = new Set();
  return String(text || '')
    .split(/[\n\r,;•·]+|\.\s+|\.$|\s+\/\s+|\s+&\s+|\s+and\s+/i)
    .map((part) => part.replace(/^[\s\-*\d.)]+/, '').trim())
    .filter((part) => {
      const key = meaningfulWords(part).join(' ');
      if (!key || seen.has(key)) return false; // ignore empty and duplicate requirements
      seen.add(key);
      return true;
    });
};

const normalizePlace = (text) =>
  String(text || '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

// Location fit as 0, 50 or 100 with a plain-English reason.
const locationFit = (candidateLocation, job) => {
  if (job.job_type === 'Remote' || /\bremote\b/i.test(job.location || '')) {
    return { points: 100, reason: 'Remote job: location does not matter' };
  }
  const candidate = normalizePlace(candidateLocation);
  const target = normalizePlace(job.location);
  if (!candidate.length) return { points: 0, reason: 'Add your location to your profile to improve this score' };
  if (!target.length) return { points: 0, reason: 'The job has no location' };
  if (candidate[0] === target[0]) return { points: 100, reason: `Same city: ${job.location}` };
  if (candidate[candidate.length - 1] === target[target.length - 1]) {
    return { points: 50, reason: `Same country, different city (${candidateLocation} vs ${job.location})` };
  }
  return { points: 0, reason: `Different location (${candidateLocation} vs ${job.location})` };
};

/**
 * @param {{skills?: string, location?: string}|null} profile job seeker profile row (may be null)
 * @param {{requirements?: string, location?: string, job_type?: string}} job
 * @returns the score plus everything needed to explain it
 */
const scoreJob = (profile, job) => {
  const candidateWords = new Set(meaningfulWords(profile && profile.skills));
  const requirements = splitRequirements(job.requirements);

  const matched = [];
  const missing = [];
  requirements.forEach((requirement) => {
    const words = meaningfulWords(requirement);
    const hits = words.filter((word) => candidateWords.has(word)).length;
    // MORE than half: 1 of 2 words is not enough, 2 of 3 is.
    (hits * 2 > words.length ? matched : missing).push(requirement);
  });

  const coverage = requirements.length ? matched.length / requirements.length : 0;
  const location = locationFit(profile && profile.location, job);
  const skillsPoints = Math.round(coverage * 100 * SKILLS_WEIGHT * 10) / 10;
  const locationPoints = Math.round(location.points * LOCATION_WEIGHT * 10) / 10;

  return {
    score: Math.round(skillsPoints + locationPoints),
    skills: {
      coverage: Math.round(coverage * 100),
      matched,
      missing,
      total: requirements.length,
      note: requirements.length ? null : 'The employer has not listed requirements for this job'
    },
    location: { points: location.points, reason: location.reason },
    breakdown: { skillsPoints, locationPoints, skillsWeight: SKILLS_WEIGHT, locationWeight: LOCATION_WEIGHT }
  };
};

module.exports = { scoreJob, splitRequirements, tokenize, meaningfulWords, locationFit };
