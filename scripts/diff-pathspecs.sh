# Pathspecs appended to git diff so lockfiles and generated trees do not
# consume the review budget. Sourced by generate-diff.sh.
DIFF_PATHSPECS=(
  .
  ':(exclude)package-lock.json'
  ':(exclude)yarn.lock'
  ':(exclude)pnpm-lock.yaml'
  ':(exclude)npm-shrinkwrap.json'
  ':(exclude)composer.lock'
  ':(exclude)Pipfile.lock'
  ':(exclude)poetry.lock'
  ':(exclude)Gemfile.lock'
  ':(exclude)go.sum'
  ':(exclude)Cargo.lock'
  ':(exclude)*.min.js'
  ':(exclude)*.min.css'
  ':(exclude)dist/**'
  ':(exclude)build/**'
  ':(exclude)vendor/**'
)
