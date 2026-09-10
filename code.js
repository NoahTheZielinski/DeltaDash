(function CONSOLELOG_WRAPPER() {
    const originalLog = console.log;
    const VERBOSE = Symbol('VERBOSE');

    window.VERBOSE = VERBOSE;

    const sourceCache = new Map();

    function getSource(url) {
        if (sourceCache.has(url)) {
            return sourceCache.get(url);
        }

        try {
            const xhr = new XMLHttpRequest();

            xhr.open('GET', url, false);
            xhr.send(null);

            if (xhr.status >= 200 && xhr.status < 400) {
                sourceCache.set(url, xhr.responseText);
                return xhr.responseText;
            }
        } catch {
            // Fall through to normal console.log behavior.
        }

        return null;
    }

    function getStackLocation(stack) {
        if (!stack) return null;

        const lines = stack.split('\n');

        for (let i = 2; i < lines.length; i++) {
            const line = lines[i].trim();

            let match = line.match(
                /^at\s+(.*?)\s+\((.*):(\d+):(\d+)\)$/
            );

            if (match) {
                return {
                    functionName: match[1],
                    url: match[2],
                    line: Number(match[3]),
                    column: Number(match[4])
                };
            }

            match = line.match(
                /^at\s+(.*):(\d+):(\d+)$/
            );

            if (match) {
                return {
                    functionName: null,
                    url: match[1],
                    line: Number(match[2]),
                    column: Number(match[3])
                };
            }
        }

        return null;
    }

    function getFileName(url) {
        try {
            const pathname = new URL(url, location.href).pathname;

            let name = pathname.substring(
                pathname.lastIndexOf('/') + 1
            );

            return name.replace(/\.[^.]+$/, '') || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    function stripStringsAndComments(source) {
        let result = '';
        let state = 'normal';

        for (let i = 0; i < source.length; i++) {
            const c = source[i];
            const n = source[i + 1];

            if (state === 'normal') {
                if (c === '/' && n === '/') {
                    result += '  ';
                    i++;
                    state = 'lineComment';
                    continue;
                }

                if (c === '/' && n === '*') {
                    result += '  ';
                    i++;
                    state = 'blockComment';
                    continue;
                }

                if (c === '"') {
                    result += ' ';
                    state = 'doubleQuote';
                    continue;
                }

                if (c === "'") {
                    result += ' ';
                    state = 'singleQuote';
                    continue;
                }

                if (c === '`') {
                    result += ' ';
                    state = 'template';
                    continue;
                }

                result += c;
                continue;
            }

            if (state === 'lineComment') {
                if (c === '\n') {
                    result += '\n';
                    state = 'normal';
                } else {
                    result += ' ';
                }

                continue;
            }

            if (state === 'blockComment') {
                if (c === '*' && n === '/') {
                    result += '  ';
                    i++;
                    state = 'normal';
                } else {
                    result += c === '\n' ? '\n' : ' ';
                }

                continue;
            }

            if (state === 'doubleQuote') {
                if (c === '\\') {
                    result += '  ';
                    i++;
                    continue;
                }

                if (c === '"') {
                    result += ' ';
                    state = 'normal';
                } else {
                    result += c === '\n' ? '\n' : ' ';
                }

                continue;
            }

            if (state === 'singleQuote') {
                if (c === '\\') {
                    result += '  ';
                    i++;
                    continue;
                }

                if (c === "'") {
                    result += ' ';
                    state = 'normal';
                } else {
                    result += c === '\n' ? '\n' : ' ';
                }

                continue;
            }

            if (state === 'template') {
                if (c === '\\') {
                    result += '  ';
                    i++;
                    continue;
                }

                if (c === '`') {
                    result += ' ';
                    state = 'normal';
                } else {
                    result += c === '\n' ? '\n' : ' ';
                }
            }
        }

        return result;
    }

    function findEnclosingNames(source, position) {
        const clean = stripStringsAndComments(source);
        const stack = [];

        for (let i = 0; i < position; i++) {
            if (clean[i] === '{') {
                stack.push(i);
            } else if (clean[i] === '}') {
                stack.pop();
            }
        }

        const names = [];

        for (const bracePosition of stack) {
            const before = clean.slice(
                Math.max(0, bracePosition - 300),
                bracePosition
            );

            let name = null;
            let match;

            // const Foo = {
            // let Foo = {
            // var Foo = {
            match = before.match(
                /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/
            );

            if (match) {
                name = match[1];
            }

            // function foo() {
            // async function foo() {
            if (!name) {
                match = before.match(
                    /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/
                );

                if (match) {
                    name = match[1];
                }
            }

            // class Foo {
            if (!name) {
                match = before.match(
                    /class\s+([A-Za-z_$][\w$]*)\s*(?:extends[^{}]+)?$/
                );

                if (match) {
                    name = match[1];
                }
            }

            // init() {
            // async init() {
            if (!name) {
                match = before.match(
                    /(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/
                );

                if (match) {
                    name = match[1];
                }
            }

            // init: () => {
            if (!name) {
                match = before.match(
                    /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>?\s*$/
                );

                if (match) {
                    name = match[1];
                }
            }

            // Menu: {
            if (!name) {
                match = before.match(
                    /([A-Za-z_$][\w$]*)\s*:\s*$/
                );

                if (match) {
                    name = match[1];
                }
            }

            if (name) {
                names.push(name);
            }
        }

        return names;
    }

    function resolveContext(location) {
        const source = getSource(location.url);

        if (!source) {
            return null;
        }

        const lines = source.split('\n');

        if (!lines[location.line - 1]) {
            return null;
        }

        let position = 0;

        for (let i = 0; i < location.line - 1; i++) {
            position += lines[i].length + 1;
        }

        position += Math.max(0, location.column - 1);

        const names = findEnclosingNames(source, position);

        if (!names.length) {
            return null;
        }

        return names.join('.');
    }

    console.log = function (...args) {
        if (args[0] !== VERBOSE) {
            return originalLog.apply(console, args);
        }

        args.shift();

        const stack = new Error().stack;
        const location = getStackLocation(stack);

        if (!location) {
            return originalLog.apply(console, args);
        }

        const fileName = getFileName(location.url);

        let context = null;

        try {
            context = resolveContext(location);
        } catch {
            context = null;
        }

        if (context) {
            originalLog(
                `[${fileName}|${context}]`,
                ...args
            );
        } else {
            let functionName =
                location.functionName || 'anonymous';

            if (functionName.startsWith('Object.')) {
                functionName = functionName.slice(7);
            }

            originalLog(
                `[${fileName}|${functionName}]`,
                ...args
            );
        }
    };
})();

(function themeCookieAndOverlay() {
    const THEME_COOKIE_NAME = 'themeName';

    function getCookie(name) {
        const match = document.cookie.match(
            new RegExp('(?:^|; )' + name + '=([^;]*)')
        );

        return match ? decodeURIComponent(match[1]) : null;
    }

    function reopenButton() {

        return document.getElementById('themePickerReopen');
    }

    function exposeCarouselMenu() {

        const overlay =
            document.getElementById('themePickerOverlay');

        if (overlay) {
            overlay.style.display = '';
        }

        const button =
            reopenButton();

        if (button) {
            button.classList.add(
                'theme-picker-reopen--hidden'
            );
        }
    }

    function hideCarouselMenu() {

        const overlay =
            document.getElementById('themePickerOverlay');

        if (overlay) {
            overlay.style.display = 'none';
        }

        const button =
            reopenButton();

        if (button) {
            button.classList.remove(
                'theme-picker-reopen--hidden'
            );
        }
    }

    // Exposed so the theme-picker IIFE can hide the overlay itself
    // once the user actually commits a theme (click/Enter), and so
    // the reopen button's own click handler can bring the overlay
    // back — not just on the cookie-found page-load path above.
    window.hideCarouselMenu = hideCarouselMenu;
    window.exposeCarouselMenu = exposeCarouselMenu;

    function initReopenButton() {

        const button =
            reopenButton();

        if (!button) {
            return;
        }

        button.addEventListener(
            'click',
            () => {
                exposeCarouselMenu();
            }
        );
    }

    document.addEventListener(
        'DOMContentLoaded',
        initReopenButton
    );

    function checkThemeCookieOnLoad() {

        const savedTheme =
            getCookie(THEME_COOKIE_NAME);

        if (savedTheme) {
            document.documentElement.setAttribute(
                'data-theme',
                savedTheme
            );

            hideCarouselMenu();
        } else {
            exposeCarouselMenu();

            document.documentElement.setAttribute(
                'data-theme',
                'dark'
            );
        }
    }

    document.addEventListener(
        'DOMContentLoaded',
        checkThemeCookieOnLoad
    );
})();

(function themePicker() {
    // NOTE on this rewrite: the Carousel class in custom-html.js has
    // NO setHook() method, and its #config (including scroll_hook /
    // child_selected_hook) is a truly private field — there is no
    // way to register a callback on an already-declared, markup-
    // created carousel from outside the class. The only things the
    // class exposes for this purpose are:
    //   - a live `selected_item` getter (readable any time)
    //   - a one-time 'carousel-init' DOM event (fires once, at init)
    // So instead of hooking internals, this listens for the exact
    // same triggers the component itself listens for ('mousedown' on
    // the centered child, and Enter) to know when a selection should
    // be committed, and polls `selected_item` to keep the live theme
    // preview in sync while scrolling.

    function applyTheme(themeName) {

        if (!themeName) {
            return;
        }

        document.documentElement.setAttribute(
            'data-theme',
            themeName
        );
    }

    function realChildren(carousel) {

        return [...carousel.children].filter(
            child => child.classList.contains('theme-card')
        );
    }

    function themeNameAtSelection(carousel) {

        const cards =
            realChildren(carousel);

        if (cards.length === 0) {
            return null;
        }

        const index =
            (
                (carousel.selected_item % cards.length)
                + cards.length
            )
            % cards.length;

        return cards[index].dataset.themeName;
    }

    function commitTheme(carousel) {

        const themeName =
            themeNameAtSelection(carousel);

        if (!themeName) {
            return;
        }

        applyTheme(themeName);

        // 1 year expiry.
        const maxAgeSeconds =
            60 * 60 * 24 * 365;

        document.cookie =
            'themeName=' + encodeURIComponent(themeName)
            + '; path=/; max-age=' + maxAgeSeconds;

        if (typeof window.hideCarouselMenu === 'function') {
            window.hideCarouselMenu();
        }
    }

    function resolveClickedRealChild(carousel, eventTarget) {

        const children =
            realChildren(carousel);

        let node =
            eventTarget;

        while (node && node !== carousel) {

            if (children.includes(node)) {
                return node;
            }

            // A click may land on a ghost clone standing in for a
            // real child (see custom-html.js #acquireGhost) — those
            // clones carry a _ghostSource back-reference.
            if (node._ghostSource) {

                const source =
                    node._ghostSource;

                if (children.includes(source)) {
                    return source;
                }
            }

            node =
                node.parentElement;
        }

        return null;
    }

    function initThemePicker() {

        const carousel =
            document.getElementById('themePickerCarousel');

        if (!carousel) {
            return;
        }

        // Live preview: whenever the carousel scrolls (by any
        // input), re-read whichever card is currently centered and
        // preview that theme. Polling via rAF since there's no
        // scroll event exposed on the element itself.
        let lastPreviewed =
            null;

        function pollSelection() {

            const centerIndex =
                Math.round(carousel.selected_item);

            if (centerIndex !== lastPreviewed) {

                lastPreviewed =
                    centerIndex;

                applyTheme(
                    themeNameAtSelection(carousel)
                );
            }

            requestAnimationFrame(pollSelection);
        }

        requestAnimationFrame(pollSelection);

        // IMPORTANT: the carousel's own scroll-justification includes
        // 'click_item' (see the HTML attribute), which means the real
        // Carousel class registers its OWN 'mousedown' listener (in
        // bubble phase, during #initialize()) that immediately calls
        // scroll('click_item', clickedIndex, false) — synchronously
        // re-centering #currentItem to whatever was just clicked,
        // BEFORE any bubble-phase listener we add afterward gets to
        // run on that same event. So by the time a normal (bubbling)
        // listener of ours checks `selected_item`, the class has
        // ALREADY re-centered on the clicked item and it always
        // looks "already centered" — that was the bug. To read the
        // state as it was BEFORE this click's own scroll takes
        // effect, we listen in the CAPTURE phase (fires before any
        // bubble-phase listener, including the class's own),
        // recording what was centered prior to this click.
        let preClickCenteredChild =
            null;

        carousel.addEventListener(
            'mousedown',
            event => {

                if (event.button !== 0) {
                    return;
                }

                const children =
                    realChildren(carousel);

                const centeredIndex =
                    (
                        (carousel.selected_item % children.length)
                        + children.length
                    )
                    % children.length;

                preClickCenteredChild =
                    children[centeredIndex] || null;
            },
            { capture: true }
        );

        // Double-click detection layered on top ourselves — the base
        // Carousel class has no double-click concept at all, so this
        // is tracked independently of selectItem_justification.
        const doubleClickWindowMs =
            400;

        let lastClickChild =
            null;

        let lastClickTime =
            0;

        carousel.addEventListener(
            'mousedown',
            event => {

                if (event.button !== 0) {
                    return;
                }

                const clicked =
                    resolveClickedRealChild(carousel, event.target);

                if (!clicked) {
                    return;
                }

                const now =
                    performance.now();

                const isDoubleClick =
                    clicked === lastClickChild
                    && (now - lastClickTime) <= doubleClickWindowMs;

                if (isDoubleClick) {

                    // Double-click always selects, regardless of
                    // whether the clicked item was centered.
                    commitTheme(carousel);

                    // Reset so three rapid clicks register as one
                    // double-click + one fresh single, not two
                    // overlapping double-clicks.
                    lastClickChild =
                        null;

                    lastClickTime =
                        0;

                    return;
                }

                lastClickChild =
                    clicked;

                lastClickTime =
                    now;

                // Single click: only selects if this item was
                // ALREADY centered before this click (i.e. it's the
                // one the carousel's own click_item scroll handler
                // is about to re-center onto anyway, rather than a
                // click that's scrolling a new item into the
                // center). Otherwise, let the class's own
                // click_item handler just scroll it to center — no
                // selection.
                if (clicked === preClickCenteredChild) {
                    commitTheme(carousel);
                }
            }
        );

        carousel.addEventListener(
            'keydown',
            event => {

                if (event.key !== 'Enter') {
                    return;
                }

                commitTheme(carousel);
            }
        );

        carousel.addEventListener(
            'carousel-init',
            () => {

                applyTheme(
                    themeNameAtSelection(carousel)
                );
            }
        );

        applyTheme(
            themeNameAtSelection(carousel)
        );
    }

    document.addEventListener(
        'DOMContentLoaded',
        initThemePicker
    );
})();

(function scrollFadeSections() {
    // Determines which of the 7 .scroll-section elements is currently
    // "focused" (its own vertical center closest to the viewport's
    // vertical center) and adds/removes the --pinned class on that
    // section's .scroll-section__content only. All animation (fade +
    // lerp) is handled purely by the CSS transition on that class —
    // this just decides WHICH ONE has it, every frame.

    const PINNED_CLASS =
        'scroll-section__content--pinned';

    const ABOVE_CLASS =
        'scroll-section__content--above';

    let sections =
        [];

    let ticking =
        false;

    function collectSections() {

        const container =
            document.getElementById('scrollSections');

        if (!container) {
            return [];
        }

        return [...container.querySelectorAll('.scroll-section')].map(
            section => ({
                section,
                content: section.querySelector(
                    '.scroll-section__content'
                ),
                indexLabel: section.querySelector(
                    '.scroll-section__index'
                )
            })
        ).filter(
            entry => entry.content !== null
        );
    }

    function closestSectionIndex() {

        const viewportCenter =
            window.innerHeight / 2;

        let closestIndex =
            -1;

        let closestDistance =
            Infinity;

        sections.forEach(
            ({ section }, index) => {

                const rect =
                    section.getBoundingClientRect();

                const sectionCenter =
                    rect.top + rect.height / 2;

                const distance =
                    Math.abs(
                        sectionCenter - viewportCenter
                    );

                if (distance < closestDistance) {

                    closestDistance =
                        distance;

                    closestIndex =
                        index;
                }
            }
        );

        return closestIndex;
    }

    function updatePinnedSection() {

        ticking =
            false;

        if (sections.length === 0) {
            return;
        }

        const focusedIndex =
            closestSectionIndex();

        const LABEL_VISIBLE_CLASS =
            'scroll-section__index--visible';

        sections.forEach(
            ({ content, indexLabel }, index) => {

                if (index === focusedIndex) {

                    content.classList.add(
                        PINNED_CLASS
                    );

                    content.classList.remove(
                        ABOVE_CLASS
                    );

                    if (indexLabel) {

                        indexLabel.classList.add(
                            LABEL_VISIBLE_CLASS
                        );
                    }

                } else if (index < focusedIndex) {

                    // Already scrolled past — exits/waits above,
                    // continuing in the direction it was scrolled.
                    content.classList.remove(
                        PINNED_CLASS
                    );

                    content.classList.add(
                        ABOVE_CLASS
                    );

                    if (indexLabel) {

                        indexLabel.classList.remove(
                            LABEL_VISIBLE_CLASS
                        );
                    }

                } else {

                    // Not yet reached — waits below, ready to lerp
                    // up into place. This is the base/default
                    // (no extra class) state.
                    content.classList.remove(
                        PINNED_CLASS
                    );

                    content.classList.remove(
                        ABOVE_CLASS
                    );

                    if (indexLabel) {

                        indexLabel.classList.remove(
                            LABEL_VISIBLE_CLASS
                        );
                    }
                }
            }
        );
    }

    function onScrollOrResize() {

        if (ticking) {
            return;
        }

        ticking =
            true;

        requestAnimationFrame(
            updatePinnedSection
        );
    }

    function init() {

        sections =
            collectSections();

        if (sections.length === 0) {
            return;
        }

        window.addEventListener(
            'scroll',
            onScrollOrResize,
            { passive: true }
        );

        window.addEventListener(
            'resize',
            onScrollOrResize
        );

        // Establish the initial pinned section on load, before any
        // scroll event has fired.
        updatePinnedSection();
    }

    document.addEventListener(
        'DOMContentLoaded',
        init
    );
})();

(function mouseWithinCarouselBounds() {
    // Every carousel renders its items as absolutely-positioned
    // children (position: absolute; left/top: 50% + a translate
    // offset — see #render() in custom-html.js), and the carousel
    // element's OWN box (its authored width/height in CSS) does not
    // grow, shrink, or clip to fit them. With enough exposed items
    // and small/negative items-separation, cards routinely render
    // well outside the container's own rectangle — #getToKnowCarousel
    // in section 3 is exactly this: exposed-items="5" cards each
    // 33rem wide at -26rem separation span roughly 61rem total,
    // inside a container only 48rem wide, so the two outer cards
    // are visibly sitting ~6.5rem past each edge of the container's
    // own box.
    //
    // Checking mouse-within using ONLY the container's own
    // getBoundingClientRect() (as an earlier version of this did)
    // is therefore wrong in exactly this case: moving the mouse
    // onto a card that's outside the container's box reads as
    // "left the carousel", even though the user is still visibly
    // over one of its cards. This instead unions the container's
    // rect with the actual rendered rect of every one of its
    // children (real items AND the ghost clones used for
    // wrap-around — both are real, visible, positioned elements;
    // see #acquireGhost()) — i.e. the true visible/interactive
    // footprint — and checks the mouse against THAT union.
    //
    // Fully transparent/culled items are excluded: #render() sets
    // opacity: 0 and pointer-events: none on anything outside its
    // rendered range, and those are invisible, so they must not
    // count toward "the mouse is visibly over this carousel".

    const WITHIN_CLASS =
        'tidbit-carousel--mouse-within';

    let lastX =
        null;

    let lastY =
        null;

    function pointerWithinRect(rect, x, y) {

        return x >= rect.left
            && x <= rect.right
            && y >= rect.top
            && y <= rect.bottom;
    }

    function isVisible(element) {

        const opacity =
            Number.parseFloat(
                element.style.opacity
            );

        // An element #render() hasn't touched at all (opacity
        // never set) is still a normal, visible child — only
        // explicitly-zeroed/near-zero opacity should be
        // excluded.
        return Number.isNaN(opacity) || opacity > 0.01;
    }

    function carouselFootprintContains(carousel, x, y) {

        if (
            pointerWithinRect(
                carousel.getBoundingClientRect(),
                x,
                y
            )
        ) {
            return true;
        }

        for (const child of carousel.children) {

            // Real items sit directly under the carousel;
            // ghost clones sit one level deeper, inside the
            // carousel's internal ghost-container wrapper (see
            // #ghostContainer in custom-html.js) — checking
            // both this element's own children AND their
            // children covers real items and ghosts alike
            // without needing to know which wrapper is which.
            const candidates =
                child.children.length > 0
                    ? [child, ...child.children]
                    : [child];

            for (const candidate of candidates) {

                if (!isVisible(candidate)) {
                    continue;
                }

                if (
                    pointerWithinRect(
                        candidate.getBoundingClientRect(),
                        x,
                        y
                    )
                ) {
                    return true;
                }
            }
        }

        return false;
    }

    function sync() {

        if (lastX === null || lastY === null) {
            return;
        }

        document.querySelectorAll(
            'tidbit-carousel'
        ).forEach(
            carousel => {

                const within =
                    carouselFootprintContains(
                        carousel,
                        lastX,
                        lastY
                    );

                carousel.classList.toggle(
                    WITHIN_CLASS,
                    within
                );
            }
        );
    }

    window.addEventListener(
        'mousemove',
        event => {

            lastX =
                event.clientX;

            lastY =
                event.clientY;

            sync();
        },
        { passive: true }
    );

    window.addEventListener(
        'scroll',
        sync,
        { passive: true }
    );

    window.addEventListener(
        'resize',
        sync
    );

    // Exposed so other modules in this file can ask "is the mouse
    // currently within this carousel's own bounds" without
    // maintaining a second copy of the same tracking.
    window.isMouseWithinCarousel =
        function (carousel) {

            return carousel.classList.contains(
                WITHIN_CLASS
            );
        };
})();

(function keepCarouselFocusedWhileMouseWithinBounds() {
    // The Carousel class's own focus handling is wired to native
    // mouseenter/mouseleave on its own element (see
    // focus_justification/unfocus_justification in custom-html.js),
    // which fire based on the browser's per-element hit-test at the
    // cursor's exact pixel — not "is the cursor within this
    // container's own rectangle". Every carousel's items are
    // absolutely-positioned children the component draws itself,
    // and can be taller/wider than the container box, sit at the
    // same z-level as a sibling's items, or leave small gaps at the
    // container's own edges — any of which can make the mouse
    // register as having "left" the carousel (triggering
    // unfocus('mouse_leave'), which drops keyboard input) even
    // though it's still visually over one of the carousel's own
    // cards.
    //
    // This corrects that using true geometry (the --mouse-within
    // class from mouseWithinCarouselBounds above, which measures
    // getBoundingClientRect() directly and ignores what's painted
    // on top): any time the mouse is within a carousel's real
    // bounds, this makes sure that carousel is focused — even if
    // the component's own mouseenter/mouseleave logic just disagreed
    // — by re-asserting focus() one frame later. A one-frame
    // self-correction reads as "never actually lost focus" to the
    // user, since nothing keyboard-driven can happen in the gap.

    function sync() {

        document.querySelectorAll(
            'tidbit-carousel'
        ).forEach(
            carousel => {

                if (typeof carousel.focus !== 'function') {
                    return;
                }

                const within =
                    window.isMouseWithinCarousel(carousel);

                if (within && !carousel.focused) {
                    carousel.focus('mouse_enter');
                }
            }
        );

        requestAnimationFrame(sync);
    }

    requestAnimationFrame(sync);

    // The component's own click_away unfocus (default
    // unfocus_justification) gates on native :hover — this.matches(
    // ':hover') — at the moment of a window 'mousedown'. That's the
    // same per-pixel hit-test problem all over again: clicking a
    // card that's genuinely within the carousel's real footprint,
    // but outside its own authored box, reads as ':hover' === false
    // to the carousel's internal listener, so the click immediately
    // unfocuses it — one frame before this module's own sync() loop
    // re-focuses it, producing a visible focus/unfocus flicker.
    //
    // A capture-phase 'mousedown' listener on window ALWAYS runs
    // before the component's own bubble-phase window listener that
    // does the actual unfocusing (capture reaches window first on
    // the way down; the component's listener is a normal bubble-
    // phase one). So when the click is genuinely within a
    // carousel's real footprint, stopping propagation here prevents
    // that internal click_away check from ever running for this
    // click, and the carousel simply stays focused as intended.
    window.addEventListener(
        'mousedown',
        event => {

            const withinAny =
                [
                    ...document.querySelectorAll(
                        'tidbit-carousel'
                    )
                ].some(
                    carousel =>
                        window.isMouseWithinCarousel(carousel)
                );

            if (withinAny) {
                event.stopPropagation();
            }
        },
        { capture: true }
    );
})();

(function productsCarouselSection4Override() {
    // #productsWrapperCarousel (section 4) needs ArrowUp/ArrowDown
    // to drive ITS OWN scrolling while that section is in view, and
    // only fall through to changing sections once the carousel is
    // already at its top/bottom row. Two independent mechanisms
    // were tried before this and neither reliably won the race
    // against the page-level section-nav listener:
    //   - carousel.focus('mouse_enter') is gated behind the
    //     component's own #focused flag/justification list, and its
    //     mouseleave-triggered unfocus() could silently drop
    //     keyboard focus at any point with no page-level visibility
    //     into whether that happened.
    //   - Reading carousel.selected_item from a window-capture
    //     keydown listener depends on the carousel actually holding
    //     DOM focus in the first place for a comparison to even be
    //     reachable.
    //
    // So this is a direct, section-4-specific override: while
    // section 4 is the section centered in the viewport, ArrowUp/
    // ArrowDown/PageUp/PageDown are intercepted at the window in
    // the CAPTURE phase (before sectionNavigation's own bubble-
    // phase listener can see them at all) and handled here
    // explicitly:
    //   - if the carousel can still move in that direction, call
    //     its scroll('arrows_vertical', ±1) directly and swallow
    //     the event completely (stopImmediatePropagation +
    //     preventDefault) — bypassing the component's own keydown
    //     handler and DOM-focus requirement entirely, so it works
    //     regardless of literal focus state;
    //   - only once it's already at that end does the event pass
    //     through untouched, so sectionNavigation changes sections
    //     exactly as it already does for every other section.

    const CAROUSEL_ID =
        'productsWrapperCarousel';

    const VERTICAL_KEYS_TO_DIRECTION = {
        ArrowDown: 1,
        PageDown: 1,
        ArrowUp: -1,
        PageUp: -1
    };

    let carousel =
        null;

    let section =
        null;

    function isSectionCentered() {

        const rect =
            section.getBoundingClientRect();

        const sectionCenter =
            rect.top + rect.height / 2;

        const viewportCenter =
            window.innerHeight / 2;

        return Math.abs(sectionCenter - viewportCenter)
            < window.innerHeight / 2;
    }

    function realChildCount() {

        // #initialize() always appends exactly one ghost
        // container div as the carousel's own last permanent
        // child (see custom-html.js), so every other child is
        // a real item.
        return Math.max(
            0,
            carousel.children.length - 1
        );
    }

    function atBoundary(direction) {

        const itemCount =
            realChildCount();

        if (itemCount === 0) {
            return true;
        }

        if (direction > 0) {

            return carousel.selected_item
                >= itemCount - 1;
        }

        return carousel.selected_item <= 0;
    }

    function onWindowKeyDownCapture(event) {

        if (!carousel || !section) {
            return;
        }

        const direction =
            VERTICAL_KEYS_TO_DIRECTION[event.key];

        if (direction === undefined) {
            return;
        }

        if (event.repeat) {

            // Mirrors the carousel's own repeat-ignoring
            // behavior for held keys (see custom-html.js) —
            // otherwise a held arrow key would queue a flood of
            // scroll() calls here.
            return;
        }

        const target =
            event.target;

        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target.isContentEditable
        ) {
            return;
        }

        if (!isSectionCentered()) {

            // Section 4 isn't the one in view — let the key
            // through untouched for sectionNavigation/other
            // carousels to handle as normal.
            return;
        }

        if (atBoundary(direction)) {

            // Already at the top/bottom row — let this key
            // continue through so sectionNavigation changes
            // sections, same as it would for any other section.
            return;
        }

        // Still room to move inside the carousel: drive its
        // scroll directly and fully swallow the key here so
        // nothing else (the carousel's own keydown handler,
        // sectionNavigation) also reacts to it.
        event.preventDefault();
        event.stopImmediatePropagation();

        carousel.scroll(
            'arrows_vertical',
            direction
        );
    }

    function init() {

        carousel =
            document.getElementById(CAROUSEL_ID);

        if (!carousel) {
            return;
        }

        section =
            carousel.closest('.scroll-section');

        if (!section) {
            return;
        }

        window.addEventListener(
            'keydown',
            onWindowKeyDownCapture,
            { capture: true }
        );
    }

    document.addEventListener(
        'DOMContentLoaded',
        init
    );
})();

(function carouselVerticalKeyBoundary() {
    // #themePickerCarousel is the other carousel declaring
    // 'arrows_vertical' in its own scroll-justification (see
    // index.html) — it wraps (wrap-items="true"), so it never has a
    // real top/bottom boundary the way #productsWrapperCarousel
    // does, and it's reached by an explicit click on the reopen
    // button rather than by scrolling into a section, so its own
    // focus()/mouseenter handling (unlike the products carousel
    // above) isn't fighting section-scroll timing. This still stops
    // its own ArrowUp/ArrowDown from also bubbling up into
    // sectionNavigation while it's focused.

    function onWindowKeyDownCapture(event) {

        if (
            event.key !== 'ArrowDown'
            && event.key !== 'ArrowUp'
            && event.key !== 'PageDown'
            && event.key !== 'PageUp'
        ) {
            return;
        }

        const carousel =
            event.target.closest?.('#themePickerCarousel');

        if (!carousel) {
            return;
        }

        // Wrapping carousel — always has room to move, so this
        // key is always destined for the carousel and never for
        // section navigation.
        event.stopPropagation();
    }

    window.addEventListener(
        'keydown',
        onWindowKeyDownCapture,
        { capture: true }
    );
})();

(function deactivateUnfocusedNestedCarousels() {
    // #productsWrapperCarousel (stack-alignment="vertical") holds
    // three .products-row carousels stacked on top of each other,
    // only one of which is centered/focused at a time. The
    // non-centered rows are still fully live underneath — their own

    // horizontal carousels keep autoscrolling, still accept clicks,
    // drags and keyboard input, and are still tab-reachable — all
    // while sitting off-center and (per items-alpha-mult) partly
    // transparent. This deactivates every row carousel except the
    // one that's currently centered in #productsWrapperCarousel.
    //
    // The Carousel class has no enable/disable concept and no
    // parent/child relationship of its own (see custom-html.js), so
    // this is built entirely from its public surface: the
    // 'carousel-init' event (to discover each row carousel once
    // it's ready) and the live `selected_item` getter (polled, same
    // approach the theme-picker IIFE above uses, since there's no
    // scroll event exposed on the element itself).

    const DEACTIVATED_CLASS =
        'products-carousel--deactivated';

    function realChildCount(carousel) {

        return Math.max(
            0,
            carousel.children.length - 1
        );
    }

    function centeredRealIndex(carousel) {

        const itemCount =
            realChildCount(carousel);

        if (itemCount === 0) {
            return -1;
        }

        const rounded =
            Math.round(carousel.selected_item);

        if (!carousel.wrap_items) {

            // selected_item is already clamped into
            // [0, itemCount - 1] directly for a non-wrapping
            // carousel (see scroll()'s Wrapping region in
            // custom-html.js) — no modular wrap needed.
            return Math.max(
                0,
                Math.min(
                    itemCount - 1,
                    rounded
                )
            );
        }

        return (
            (rounded % itemCount)
            + itemCount
        )
        % itemCount;
    }

    function deactivate(rowCarousel) {

        if (
            rowCarousel.classList.contains(
                DEACTIVATED_CLASS
            )
        ) {
            return;
        }

        rowCarousel.classList.add(
            DEACTIVATED_CLASS
        );

        // Blocks click/drag/wheel input immediately (see the
        // matching CSS rule) — pointer-events: none on a
        // focused element does not by itself drop keyboard
        // focus, so that's handled explicitly below.
        if (typeof rowCarousel.unfocus === 'function') {
            rowCarousel.unfocus('click_away');
            rowCarousel.unfocus('mouse_leave');
        }

        // Belt-and-suspenders: unfocus() only succeeds if the
        // carousel's own unfocus_justification includes
        // whichever reason was passed above. Directly blurring
        // and pulling it out of the tab order guarantees it
        // can no longer receive keyboard input either way.
        HTMLElement.prototype.blur.call(rowCarousel);

        rowCarousel.setAttribute(
            'tabindex',
            '-1'
        );
    }

    function activate(rowCarousel) {

        if (
            !rowCarousel.classList.contains(
                DEACTIVATED_CLASS
            )
        ) {
            return;
        }

        rowCarousel.classList.remove(
            DEACTIVATED_CLASS
        );

        rowCarousel.setAttribute(
            'tabindex',
            '0'
        );
    }

    function trackWrapper(wrapperCarousel) {

        const rowCarousels =
            [
                ...wrapperCarousel.querySelectorAll(
                    ':scope > .products-row > tidbit-carousel'
                )
            ];

        if (rowCarousels.length === 0) {
            return;
        }

        let lastCenteredIndex =
            null;

        function sync() {

            const centeredIndex =
                centeredRealIndex(wrapperCarousel);

            if (centeredIndex !== lastCenteredIndex) {

                lastCenteredIndex =
                    centeredIndex;

                rowCarousels.forEach(
                    (rowCarousel, index) => {

                        if (index === centeredIndex) {
                            activate(rowCarousel);
                        } else {
                            deactivate(rowCarousel);
                        }
                    }
                );
            }

            requestAnimationFrame(sync);
        }

        requestAnimationFrame(sync);
    }

    function init() {

        const wrapperCarousel =
            document.getElementById(
                'productsWrapperCarousel'
            );

        if (!wrapperCarousel) {
            return;
        }

        if (wrapperCarousel.selected_item !== undefined) {
            trackWrapper(wrapperCarousel);
        } else {

            wrapperCarousel.addEventListener(
                'carousel-init',
                () => trackWrapper(wrapperCarousel),
                { once: true }
            );
        }
    }

    document.addEventListener(
        'DOMContentLoaded',
        init
    );
})();

(function sectionNavigation() {

    const NAVIGATION_KEYS = new Set([
        'ArrowDown',
        'ArrowUp',
        'PageDown',
        'PageUp'
    ]);

    const UP_BUTTON_ID =
        'sectionNavUp';

    const DOWN_BUTTON_ID =
        'sectionNavDown';

    function getSections() {

        const container =
            document.getElementById('scrollSections');

        if (!container) {
            return [];
        }

        return [
            ...container.querySelectorAll('.scroll-section')
        ];
    }

    function getCurrentSectionIndex(sections) {

        const viewportCenter =
            window.innerHeight / 2;

        let closestIndex =
            0;

        let closestDistance =
            Infinity;

        sections.forEach(
            (section, index) => {

                const rect =
                    section.getBoundingClientRect();

                const sectionCenter =
                    rect.top + rect.height / 2;

                const distance =
                    Math.abs(
                        sectionCenter - viewportCenter
                    );

                if (distance < closestDistance) {

                    closestDistance =
                        distance;

                    closestIndex =
                        index;
                }
            }
        );

        return closestIndex;
    }

    function scrollToSection(section) {

        const rect =
            section.getBoundingClientRect();

        const targetY =
            window.scrollY
            + rect.top
            + rect.height / 2
            - window.innerHeight / 2;

        window.scrollTo({
            top: targetY,
            behavior: 'smooth'
        });
    }

    function navigate(direction) {

        const sections =
            getSections();

        if (sections.length === 0) {
            return;
        }

        const currentIndex =
            getCurrentSectionIndex(sections);

        const targetIndex =
            Math.max(
                0,
                Math.min(
                    currentIndex + direction,
                    sections.length - 1
                )
            );

        if (targetIndex === currentIndex) {
            return;
        }

        scrollToSection(
            sections[targetIndex]
        );
    }

    function updateButtonVisibility() {

        const sections =
            getSections();

        const upButton =
            document.getElementById(UP_BUTTON_ID);

        const downButton =
            document.getElementById(DOWN_BUTTON_ID);

        if (
            !upButton ||
            !downButton
        ) {
            return;
        }

        if (sections.length === 0) {

            upButton.style.display =
                'none';

            downButton.style.display =
                'none';

            return;
        }

        const currentIndex =
            getCurrentSectionIndex(sections);

        upButton.style.display =
            currentIndex > 0
                ? 'flex'
                : 'none';

        downButton.style.display =
            currentIndex < sections.length - 1
                ? 'flex'
                : 'none';
    }

    function onKeyDown(event) {

        if (!NAVIGATION_KEYS.has(event.key)) {
            return;
        }

        const target =
            event.target;

        if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target.isContentEditable
        ) {
            return;
        }

        event.preventDefault();

        if (
            event.key === 'ArrowDown' ||
            event.key === 'PageDown'
        ) {
            navigate(1);
        }

        if (
            event.key === 'ArrowUp' ||
            event.key === 'PageUp'
        ) {
            navigate(-1);
        }
    }

    function init() {

        const upButton =
            document.getElementById(UP_BUTTON_ID);

        const downButton =
            document.getElementById(DOWN_BUTTON_ID);

        if (upButton) {

            upButton.addEventListener(
                'click',
                () => navigate(-1)
            );
        }

        if (downButton) {

            downButton.addEventListener(
                'click',
                () => navigate(1)
            );
        }

        window.addEventListener(
            'keydown',
            onKeyDown
        );

        window.addEventListener(
            'scroll',
            updateButtonVisibility,
            { passive: true }
        );

        window.addEventListener(
            'resize',
            updateButtonVisibility
        );

        updateButtonVisibility();
    }

    document.addEventListener(
        'DOMContentLoaded',
        init
    );

})();