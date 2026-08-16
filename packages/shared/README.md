# @strkworld/shared

Types and constants that cross package boundaries. **No logic, no dependencies.**

If something here needs a dependency or a function body, it belongs in the
package that owns the behaviour. This package exists so `world`, `lobby` and
`privacy` can agree on a shape without importing each other.
