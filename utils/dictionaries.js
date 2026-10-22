// Every language's dictionary, registered up front. For the service worker, which can't import() a file once it
// runs (the pages read just the language they show, when they need it: translations.js loadDictionary).
import EN from '../dictionaries/en.json' with { type: 'json' };
import EL from '../dictionaries/el.json' with { type: 'json' };
import DE from '../dictionaries/de.json' with { type: 'json' };
import IT from '../dictionaries/it.json' with { type: 'json' };
import FR from '../dictionaries/fr.json' with { type: 'json' };
import ES from '../dictionaries/es.json' with { type: 'json' };
import RU from '../dictionaries/ru.json' with { type: 'json' };
import AR from '../dictionaries/ar.json' with { type: 'json' };
import HE from '../dictionaries/he.json' with { type: 'json' };
import RO from '../dictionaries/ro.json' with { type: 'json' };
import { addDictionaries } from './translations.js';

addDictionaries({ en: EN, el: EL, de: DE, it: IT, fr: FR, es: ES, ru: RU, ar: AR, he: HE, ro: RO });
