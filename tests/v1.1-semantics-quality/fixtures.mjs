export const LARGE_CORPUS_SIZE = 1024;

// eslint-disable-next-line no-control-regex -- synthetic fixture models the parser's C0/C1 scrubber.
const CONTROL_NOISE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function makeMultilingualEntry(index) {
  const id = String(index).padStart(4, '0');
  const text = `Entry ${id} | Café e\u0301 | العربية | हिन्दी | 中文 | 日本語 | 한국어 | Ελληνικά | 👩‍💻`;
  // Place nonprinting C0/C1 controls inside otherwise meaningful text.
  const noisy = text.replace('Café', 'Ca\u0000fé').replace('हिन्दी', 'हि\u0085न्दी');
  const expected = noisy.replace(CONTROL_NOISE, '').replace(/\s+/g, ' ').trim();
  return {id, noisy, expected};
}

export function appendMultilingualCorpus(document, count = LARGE_CORPUS_SIZE) {
  const expected = [];
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < count; index++) {
    const {id, noisy, expected: clean} = makeMultilingualEntry(index);
    const paragraph = document.createElement('p');
    paragraph.dataset.fixtureId = id;
    paragraph.textContent = noisy;
    fragment.append(paragraph);
    expected.push(clean);
  }
  document.body.append(fragment);
  return expected;
}

export function makeLongMultilingualText(repeats = 600) {
  return 'Résumé|中文|العربية|हिन्दी|한국어|日本語|Ελληνικά|👩‍💻|e\u0301|'.repeat(repeats);
}
