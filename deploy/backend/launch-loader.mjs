/**
 * Loader-phase witness for the standalone Backend entry.
 *
 * Dynamic import reports both entry-loading failures and errors thrown by the
 * loaded module through the same rejected promise. Matching public Error fields
 * cannot distinguish those phases because Backend code can throw an identical
 * object. These hooks run only around Node's resolver/loader, before module
 * evaluation, and publish one private bit when that exact entry fails admission.
 */

let entryUrl;
let canonicalEntryUrl;
let absoluteEntryPath;
let canonicalEntryPath;
let failureState;

export function initialize(data) {
  entryUrl = data.entryUrl;
  canonicalEntryUrl = data.canonicalEntryUrl;
  absoluteEntryPath = data.absoluteEntryPath;
  canonicalEntryPath = data.canonicalEntryPath;
  failureState = new Int32Array(data.failureBuffer);
}

function isEntryUrl(url) {
  return url === entryUrl || url === canonicalEntryUrl;
}

function isResolutionFailure(error) {
  return error instanceof Error
    && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT');
}

function isOpenFailure(error) {
  return error instanceof Error
    && error.code === 'EACCES'
    && error.syscall === 'open'
    && (error.path === absoluteEntryPath || error.path === canonicalEntryPath);
}

function markEntryAdmissionFailure() {
  Atomics.store(failureState, 0, 1);
}

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (isEntryUrl(specifier) && isResolutionFailure(error)) {
      markEntryAdmissionFailure();
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  try {
    return await nextLoad(url, context);
  } catch (error) {
    if (isEntryUrl(url) && (isResolutionFailure(error) || isOpenFailure(error))) {
      markEntryAdmissionFailure();
    }
    throw error;
  }
}
