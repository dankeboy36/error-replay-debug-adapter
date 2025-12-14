// simple globals for capture
const globalGreeting = 'hello'
const globalList = [1, 2, 3, { nested: true }]
const globalMap = { env: process.env.NODE_ENV || 'dev', flag: true }

/** @param {{ id: number; name?: string }} user */
function inner(user) {
  const factor = 2
  return crash(user.id * factor)
}

/** @param {string | number} value */
function crash(value) {
  const payload = {
    value,
    meta: { source: 'demo', globals: { globalGreeting, globalList } },
  }
  const numbers = [1, 2, 3, 4, 5]
  const doubled = numbers.map((n) => n * 2)
  const mixed = {
    arr: ['a', 'b', { deeper: true }],
    bool: false,
    date: new Date().toISOString(),
  }
  console.log('payload', payload)
  console.log('doubled', doubled, 'mixed', mixed, 'globalMap', globalMap)
  throw new Error('Boom: ' + value)
}

function main() {
  const user = { id: 21, name: 'Alice' }
  inner(user)
}

main()
