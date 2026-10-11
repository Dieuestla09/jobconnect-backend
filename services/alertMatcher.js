// Pure helpers that decide whether a job fits a saved alert's filters.
// The match percentage itself comes from matchScore.js; these are the hard filters.

// "frontend, react  junior" -> ['frontend', 'react', 'junior'] (max 10 terms)
const keywordTerms = (keywords) =>
  Array.from(
    new Set(
      String(keywords || '')
        .toLowerCase()
        .split(/[,;\s]+/)
        .map((term) => term.trim())
        .filter(Boolean)
    )
  ).slice(0, 10);

/**
 * A job passes the filters when
 *  - ANY keyword appears in its title, description, requirements or company name,
 *  - the alert location (if set) is contained in the job location (case-insensitive),
 *  - the job type (if set) is equal.
 * Empty filters are ignored.
 */
const matchesCriteria = (alert, job) => {
  const terms = keywordTerms(alert.keywords);
  if (terms.length) {
    const haystack = [job.title, job.description, job.requirements, job.company_name]
      .map((value) => String(value || '').toLowerCase())
      .join(' ');
    if (!terms.some((term) => haystack.includes(term))) return false;
  }
  if (alert.location && !String(job.location || '').toLowerCase().includes(String(alert.location).toLowerCase())) {
    return false;
  }
  if (alert.job_type && alert.job_type !== job.job_type) return false;
  return true;
};

module.exports = { keywordTerms, matchesCriteria };
