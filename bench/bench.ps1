# Runs the bench suite. --no-warnings silences the loader's deprecation notice,
# which is about Node's API, not about the measurements.
node --no-warnings --import ./bench/lib/register.mjs bench/run.mjs
