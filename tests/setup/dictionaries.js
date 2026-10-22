// Every dictionary registered before each test file, so a test can switch language and read texts at once (the pages
// read theirs when needed: utils/translations.js loadDictionary, tested in tests/utils/translations.test.js).
import EN from '../../dictionaries/en.json';
import EL from '../../dictionaries/el.json';
import DE from '../../dictionaries/de.json';
import IT from '../../dictionaries/it.json';
import FR from '../../dictionaries/fr.json';
import ES from '../../dictionaries/es.json';
import RU from '../../dictionaries/ru.json';
import AR from '../../dictionaries/ar.json';
import HE from '../../dictionaries/he.json';
import RO from '../../dictionaries/ro.json';
import { addDictionaries } from '../../utils/translations.js';

addDictionaries({ en: EN, el: EL, de: DE, it: IT, fr: FR, es: ES, ru: RU, ar: AR, he: HE, ro: RO });
