class Carousel extends HTMLElement {

    //#region State

    #DOMElement = this;
    #config = {};
    #initialized = false;

    #currentItem = 0;

    #scrollPosition = 0;
    #scrollTarget = 0;

    // The REAL CHILD ELEMENT currently being scrolled
    // toward, kept alongside the numeric #scrollTarget slot.
    // #scrollTarget alone is just an integer slot number
    // whose mapping to a real child is (slot % itemCount) —
    // if itemCount changes mid-scroll (an item added or
    // removed), that same slot number can silently end up
    // pointing at a DIFFERENT real child than the one the
    // user actually clicked/scrolled toward. Keeping the
    // element reference lets #handleChildListMutation() re-
    // derive a correct numeric target after any mutation, or
    // detect that the target itself was removed and stop
    // safely instead of animating toward a now-wrong index.
    #scrollTargetChild = null;

    #childListMutationObserver = null;

    // --- Constant-rate scroll tracking (replaces distance-remaining stepping) ---
    // Instead of re-deriving #scrollPosition each frame from
    // (scrollTarget - scrollPosition), we accumulate how much
    // scroll distance has actually elapsed at a CONSTANT rate
    // (speed * deltaTime per frame) and apply that against the
    // fixed start/total for this scroll. This guarantees a true
    // constant-velocity scroll (time-to-complete = distance / speed,
    // exactly) instead of an asymptotic/eased approach that's
    // sensitive to frame timing.
    #scrollStartPosition = 0;
    #scrollAmountTotal = 0; // signed: scrollTarget - scrollStartPosition at scroll start
    #scrollAmountDone = 0;  // unsigned: accumulated progress, 0..abs(scrollAmountTotal)

    #scrollDelta = 0;

    #focused = false;

    #playing = false;
    #paused = true;

    #scrolling = false;
    #autoscrolling = false;

    #autoscrollWaiting = false;
    #autoscrollWaitStart = 0;

    #animationFrame = null;
    #lastFrameTime = null;

    #intersectionObserver = null;

    // --- Rendering additions ---

    #separationPx = 0;
    #resizeObserver = null;
    #itemSizes = new Map(); // child -> { width, height }

    // Ghost clones used to fill wrap-around slots so
    // the real element never has to visually jump —
    // see #render()/#acquireGhost(). Ghosts live
    // inside their own wrapper element so they never
    // show up in `this.children` (which callers use
    // to mean "the real items").
    #ghostPool = []; // reusable clone elements, keyed by pool position
    #ghostContainer = null;

    //#endregion


    //#region Real Children

    /**
     * `this.children` as an array, excluding the ghost
     * clone container. Use this (not `this.children`)
     * anywhere "the real items" is meant.
     */
    #realChildren() {

        return [...this.children].filter(
            child => child !== this.#ghostContainer
        );
    }

    /**
     * Maps an unbounded integer slot to the real child
     * currently occupying it (slot mod itemCount, wrapped
     * into a positive index). Returns null if there are no
     * real children at all.
     */
    #realChildAtSlot(slot) {

        const children =
            this.#realChildren();

        const itemCount =
            children.length;

        if (itemCount === 0) {
            return null;
        }

        const index =
            (
                (slot % itemCount)
                + itemCount
            )
            % itemCount;

        return children[index];
    }

    /**
     * Given an event target (from a delegated listener on
     * the container), resolves it to whichever REAL child it
     * represents — walking up through ancestors in case the
     * click landed on something nested inside an item's own
     * markup, and mapping a ghost clone back to the real
     * element it's standing in for via the `_ghostSource`
     * reference set in #acquireGhost(). Returns
     * { child, index } (index into #realChildren(), i.e. a
     * bounded 0..itemCount-1 real index) or null if the
     * target isn't part of any item at all (e.g. a click on
     * bare container background).
     */
    #resolveClickedRealChild(eventTarget) {

        const children =
            this.#realChildren();

        // Walk up from the event target looking for either
        // a real child or a ghost, whichever is hit first —
        // this also naturally handles clicks on nested
        // elements inside an item's own markup (e.g. an
        // <img> or <span> inside a card), not just clicks on
        // the item's own top-level element.
        let node =
            eventTarget;

        while (
            node
            && node !== this.#DOMElement
        ) {

            const directIndex =
                children.indexOf(node);

            if (directIndex !== -1) {

                return {
                    child: node,
                    index: directIndex
                };
            }

            const ghostSource =
                node._ghostSource;

            if (ghostSource) {

                const sourceIndex =
                    children.indexOf(
                        ghostSource
                    );

                if (sourceIndex !== -1) {

                    return {
                        child: ghostSource,
                        index: sourceIndex
                    };
                }
            }

            node =
                node.parentElement;
        }

        return null;
    }

    //#endregion


    //#region Lifecycle

    connectedCallback() {
        this.#initialize();
    }

    disconnectedCallback() {

        if (this.#animationFrame !== null) {
            cancelAnimationFrame(
                this.#animationFrame
            );

            this.#animationFrame = null;
        }

        if (this.#intersectionObserver !== null) {
            this.#intersectionObserver.disconnect();

            this.#intersectionObserver = null;
        }

        if (this.#resizeObserver !== null) {
            this.#resizeObserver.disconnect();

            this.#resizeObserver = null;
        }
    }

    #initialize() {

        if (this.#initialized) {
            return;
        }

        // Created first so every subsequent
        // this.children-count in this method (and in
        // #getInitialItem() below) already excludes
        // it via #realChildren().
        this.#ghostContainer =
            document.createElement('div');

        this.#ghostContainer.style.display =
            'contents';

        this.#DOMElement.appendChild(
            this.#ghostContainer
        );

        const presets = {
            name: null,

            exposed_items: 5,
            selected_item: 'center',

            wrap_items: true,

            stack_alignment: 'horizontal',
            items_alignment: 'center',

            items_separation: '1rem',

            items_scale_mult: 0.85,
            items_alpha_mult: 0.85,

            autoscroll_time: -1,
            autoscroll_speed: 1,

            scroll_sensitivity: 1,
            scroll_speed: 1,

            focus_justification: [
                'click',
                'mouse_enter'
            ],

            unfocus_justification: [
                'click_away',
                'mouse_leave'
            ],

            scroll_justification: [
                'click_item',
                'scroll',
                'tab',
                'arrows_horizontal'
                // 'arrows_vertical'
            ],

            selectItem_justification: [
                'click',
                'enter'
            ],

            pause_justification: [
                'off_screen'
            ],

            play_justification: [
                'visible'
            ],

            init_hook: null,
            focus_hook: null,
            unfocus_hook: null,
            scroll_hook: null,
            child_selected_hook: null,
            pause_hook: null,
            play_hook: null,
            remove_hook: null,
            loop_hook: null
        };

        for (
            const [parameter, preset]
            of Object.entries(presets)
        ) {

            const attribute =
                parameter.replaceAll(
                    '_',
                    '-'
                );

            if (this.hasAttribute(attribute)) {

                this.#config[parameter] =
                    this.#parseAttribute(
                        this.getAttribute(attribute),
                        preset
                    );

            } else {

                this.#config[parameter] =
                    preset;
            }
        }

        this.setAttribute(
            'tabindex',
            '0'
        );

        this.#currentItem =
            this.#getInitialItem();

        this.#scrollPosition =
            this.#currentItem;

        this.#scrollTarget =
            this.#currentItem;

        this.#scrollStartPosition =
            this.#currentItem;

        this.#scrollAmountTotal =
            0;

        this.#scrollAmountDone =
            0;


        //#region Rendering Setup

        // Container needs to establish a positioning
        // context for absolutely-placed children, and
        // hide anything that scales/translates outside
        // its bounds.
        const containerStyle =
            getComputedStyle(this.#DOMElement);

        if (containerStyle.position === 'static') {

            this.#DOMElement.style.position =
                'relative';
        }

        this.#DOMElement.style.overflow =
            'hidden';

        this.#separationPx =
            this.#resolveLength(
                this.#config.items_separation
            );

        for (const child of this.#realChildren()) {
            this.#prepareChild(child);
        }

        this.#resizeObserver =
            new ResizeObserver(
                entries => {

                    for (
                        const entry
                        of entries
                    ) {

                        const target =
                            entry.target;

                        const box =
                            entry.borderBoxSize?.[0];

                        if (box) {

                            this.#itemSizes.set(
                                target,
                                {
                                    width: box.inlineSize,
                                    height: box.blockSize
                                }
                            );

                        } else {

                            this.#itemSizes.set(
                                target,
                                {
                                    width: target.offsetWidth,
                                    height: target.offsetHeight
                                }
                            );
                        }
                    }
                }
            );

        for (const child of this.#realChildren()) {

            this.#resizeObserver.observe(
                child
            );

            this.#itemSizes.set(
                child,
                {
                    width: child.offsetWidth,
                    height: child.offsetHeight
                }
            );
        }

        //#endregion


        //#region Focus Justifications

        if (
            this.#config.focus_justification.includes(
                'click'
            )
        ) {
            this.#DOMElement.addEventListener(
                'mousedown',
                event => {

                    if (event.button !== 0) {
                        return;
                    }

                    this.focus('click');
                }
            );
        }

        if (
            this.#config.focus_justification.includes(
                'mouse_enter'
            )
        ) {
            this.#DOMElement.addEventListener(
                'mouseenter',
                () => {
                    this.focus(
                        'mouse_enter'
                    );
                }
            );
        }

        //#endregion


        //#region Unfocus Justifications

        if (
            this.#config.unfocus_justification.includes(
                'click_away'
            )
        ) {
            window.addEventListener(
                'mousedown',
                () => {

                    if (
                        !this.matches(':hover')
                    ) {
                        this.unfocus(
                            'click_away'
                        );
                    }
                }
            );
        }

        if (
            this.#config.unfocus_justification.includes(
                'mouse_leave'
            )
        ) {
            this.#DOMElement.addEventListener(
                'mouseleave',
                () => {
                    this.unfocus(
                        'mouse_leave'
                    );
                }
            );
        }

        //#endregion


        //#region Scroll Justifications

        if (
            this.#config.scroll_justification.includes(
                'click_item'
            )
        ) {

            // Delegated on the CONTAINER rather than bound
            // per-child. Binding directly on each real child
            // used to silently fail to fire for any slot
            // currently showing a ghost clone of that child:
            // clones are made with cloneNode(), which never
            // copies listeners, and ghosts also have
            // pointer-events disabled — so a click landing on
            // a ghost passed straight through to whatever was
            // behind it (typically the container background),
            // which meant "click the item" only ever worked
            // for whichever slot happened to hold the real
            // element rather than any slot that VISUALLY
            // showed it. Delegating on the container and
            // resolving through #resolveClickedRealChild()
            // (which understands ghost -> source-child
            // mapping) fixes this for every slot, real or
            // ghost.
            this.#DOMElement.addEventListener(
                'mousedown',
                event => {

                    if (event.button !== 0) {
                        return;
                    }

                    const resolved =
                        this.#resolveClickedRealChild(
                            event.target
                        );

                    if (!resolved) {
                        return;
                    }

                    this.scroll(
                        'click_item',
                        resolved.index,
                        false
                    );
                }
            );
        }

        if (
            this.#config.scroll_justification.includes(
                'scroll'
            )
        ) {
            this.#DOMElement.addEventListener(
                'wheel',
                event => {

                    // Prevent the page (or any scrollable
                    // ancestor) underneath from also
                    // scrolling while the user is scrolling
                    // this carousel — otherwise every wheel
                    // tick both moves the carousel AND
                    // scrolls the surrounding page, which
                    // reads as broken/janky input capture.
                    // Only done when 'scroll' justification
                    // is actually enabled, so a carousel that
                    // doesn't use wheel input never hijacks
                    // page scroll it isn't using.
                    event.preventDefault();

                    this.#scrollDelta +=
                        event.deltaY
                        * this.#config.scroll_sensitivity
                        / 100;

                    const amount =
                        Math.trunc(
                            this.#scrollDelta
                        );

                    if (amount === 0) {
                        return;
                    }

                    this.#scrollDelta -=
                        amount;

                    this.scroll(
                        'scroll',
                        amount
                    );
                },
                // passive: false is required for
                // preventDefault() to have any effect on
                // wheel events.
                { passive: false }
            );
        }

        if (
            this.#config.scroll_justification.includes(
                'tab'
            )
        ) {
            this.#DOMElement.addEventListener(
                'keydown',
                event => {

                    // Ignore OS-generated key-repeat events
                    // from a held key. Without this, holding
                    // an arrow/Tab key floods dozens of
                    // discrete keydown events per second,
                    // each of which would otherwise queue its
                    // own index jump — the carousel would
                    // keep racing forward well after the key
                    // is released instead of stopping the
                    // instant it's let go. A single tap still
                    // has event.repeat === false, so normal
                    // one-shot scrolling is unaffected.
                    if (event.repeat) {
                        return;
                    }

                    if (event.key !== 'Tab') {
                        return;
                    }

                    this.scroll(
                        'tab',
                        event.shiftKey
                            ? -1
                            : 1
                    );
                }
            );
        }

        if (
            this.#config.scroll_justification.includes(
                'arrows_horizontal'
            )
        ) {
            this.#DOMElement.addEventListener(
                'keydown',
                event => {

                    // See the 'tab' handler above for why
                    // repeats are ignored.
                    if (event.repeat) {
                        return;
                    }

                    if (
                        event.key === 'ArrowRight'
                        || event.key === 'PageDown'
                    ) {
                        this.scroll(
                            'arrows_horizontal',
                            1
                        );
                    }

                    if (
                        event.key === 'ArrowLeft'
                        || event.key === 'PageUp'
                    ) {
                        this.scroll(
                            'arrows_horizontal',
                            -1
                        );
                    }
                }
            );
        }

        if (
            this.#config.scroll_justification.includes(
                'arrows_vertical'
            )
        ) {
            this.#DOMElement.addEventListener(
                'keydown',
                event => {

                    // See the 'tab' handler above for why
                    // repeats are ignored.
                    if (event.repeat) {
                        return;
                    }

                    if (
                        event.key === 'ArrowDown'
                        || event.key === 'PageDown'
                    ) {
                        this.scroll(
                            'arrows_vertical',
                            1
                        );
                    }

                    if (
                        event.key === 'ArrowUp'
                        || event.key === 'PageUp'
                    ) {
                        this.scroll(
                            'arrows_vertical',
                            -1
                        );
                    }
                }
            );
        }

        //#endregion


        //#region Select Item Justifications

        if (
            this.#config.selectItem_justification.includes(
                'click'
            )
        ) {

            // Delegated for the same reason as click_item
            // above — a per-child listener never fires when
            // the click lands on a ghost clone standing in
            // for that child.
            this.#DOMElement.addEventListener(
                'mousedown',
                event => {

                    if (event.button !== 0) {
                        return;
                    }

                    const resolved =
                        this.#resolveClickedRealChild(
                            event.target
                        );

                    if (!resolved) {
                        return;
                    }

                    this.child_selected(
                        'click',
                        resolved.child
                    );
                }
            );
        }

        if (
            this.#config.selectItem_justification.includes(
                'enter'
            )
        ) {
            this.#DOMElement.addEventListener(
                'keydown',
                event => {

                    if (event.key !== 'Enter') {
                        return;
                    }

                    this.child_selected(
                        'enter',
                        this.#realChildren()[
                        (
                            (this.selected_item % this.#realChildren().length)
                            + this.#realChildren().length
                        )
                        % this.#realChildren().length
                        ]
                    );
                }
            );
        }

        //#endregion


        //#region Visibility

        this.#intersectionObserver =
            new IntersectionObserver(
                entries => {

                    const entry = entries[0];

                    if (!entry) {
                        return;
                    }

                    if (entry.isIntersecting) {

                        this.play(
                            'visible'
                        );

                    } else {

                        this.pause(
                            'off_screen'
                        );
                    }
                },
                {
                    threshold: 0
                }
            );

        this.#intersectionObserver.observe(
            this.#DOMElement
        );

        //#endregion


        //#region Loop

        this.#animationFrame =
            requestAnimationFrame(
                time => this.#loop(time)
            );

        //#endregion


        // Render once immediately so the carousel
        // isn't blank before the first animation
        // frame (e.g. while paused off-screen).
        this.#render(
            this.#scrollPosition
        );

        this.#initialized = true;


        //#region Init Hook

        // A JSON.stringify/parse round-trip of #config —
        // strips functions (hooks) and gives external code a
        // plain, safe-to-read snapshot of every config value
        // without exposing the live private #config object
        // itself. Computed once and reused for both init_hook
        // and the carousel-init event below, so external code
        // sees the exact same config shape either way it
        // chooses to observe initialization.
        const configSnapshot =
            JSON.parse(
                JSON.stringify(
                    this.#config
                )
            );

        if (
            typeof this.#config.init_hook
            === 'function'
        ) {
            this.#config.init_hook(
                this,
                configSnapshot
            );
        }

        // Also dispatched as a real DOM event, independent of
        // init_hook. init_hook is a config VALUE that must
        // already be a function by the time THIS line runs —
        // for a carousel declared directly in HTML markup,
        // #initialize() runs during initial page parsing,
        // before any external <script> has had a chance to
        // set a hook, so init_hook is effectively unreachable
        // from outside code for declarative markup. A DOM
        // event has no such ordering requirement:
        // addEventListener() queues normally whether it's
        // called before or after this dispatch fires relative
        // to page load, so this is the reliable way to observe
        // "this carousel just finished initializing" — and the
        // config snapshot on detail.config — from external
        // code.
        this.#DOMElement.dispatchEvent(
            new CustomEvent(
                'carousel-init',
                {
                    bubbles: true,
                    detail: {
                        carousel: this,
                        config: configSnapshot
                    }
                }
            )
        );

        //#endregion
    }

    //#endregion


    //#region Loop

    #loop(time) {

        if (
            this.#lastFrameTime
            === null
        ) {
            this.#lastFrameTime =
                time;
        }

        const deltaTime =
            (
                time
                - this.#lastFrameTime
            )
            / 1000;

        this.#lastFrameTime =
            time;


        //#region Scroll

        if (this.#scrolling) {

            const speed =
                this.#autoscrolling
                    ? this.#config.autoscroll_speed
                    : this.#config.scroll_speed;

            // Constant-rate accumulation: advance the
            // "amount of scroll distance done" by a
            // fixed speed * deltaTime each frame, then
            // apply that against the FIXED start/total
            // recorded when this scroll began. This is
            // deliberately NOT derived from the
            // remaining distance to target (that
            // previous approach re-solved position from
            // scratch every frame based on how close it
            // already was, which is what caused the
            // autoscroll bug — any timing hiccup in one
            // frame permanently altered the shape of the
            // remaining motion instead of just shifting
            // it in time). Total time-to-complete is
            // therefore always exactly
            // abs(scrollAmountTotal) / speed, satisfying
            // "1 second per index at speed 1" exactly.
            const totalAbs =
                Math.abs(
                    this.#scrollAmountTotal
                );

            this.#scrollAmountDone =
                Math.min(
                    this.#scrollAmountDone
                    + speed * deltaTime,
                    totalAbs
                );

            const sign =
                Math.sign(
                    this.#scrollAmountTotal
                );

            this.#scrollPosition =
                this.#scrollStartPosition
                + sign * this.#scrollAmountDone;

            if (
                this.#scrollAmountDone
                >= totalAbs
            ) {

                this.#scrollPosition =
                    this.#scrollTarget;

                this.#scrolling =
                    false;

                if (
                    this.#autoscrolling
                ) {

                    this.#finishAutoscroll();

                } else {

                    this.#finishScroll();
                }
            }
        }

        //#endregion


        //#region Autoscroll

        if (
            !this.#paused
            && !this.#focused
            && !this.#scrolling
            && !this.#autoscrollWaiting
            && this.#config.autoscroll_time >= 0
        ) {

            this.#beginAutoscrollWait(
                time
            );
        }

        if (
            this.#autoscrollWaiting
        ) {

            if (
                this.#paused
                || this.#focused
            ) {

                this.#autoscrollWaiting =
                    false;

            } else if (
                (
                    time
                    - this.#autoscrollWaitStart
                )
                >= this.#config.autoscroll_time
            ) {

                this.#autoscrollWaiting =
                    false;

                this.#beginAutoscroll();
            }
        }

        //#endregion


        //#region Render

        if (!this.#paused) {

            this.#render(
                this.#scrollPosition
            );
        }

        //#endregion


        //#region Loop Hook

        if (
            typeof this.#config.loop_hook
            === 'function'
        ) {

            this.#config.loop_hook(
                this,
                {
                    config: JSON.parse(
                        JSON.stringify(
                            this.#config
                        )
                    ),

                    time,

                    delta_time: deltaTime,

                    current_item:
                        this.#currentItem,

                    scroll_position:
                        this.#scrollPosition,

                    scroll_target:
                        this.#scrollTarget,

                    scroll_delta:
                        this.#scrollDelta,

                    focused:
                        this.#focused,

                    playing:
                        this.#playing,

                    paused:
                        this.#paused,

                    scrolling:
                        this.#scrolling,

                    autoscrolling:
                        this.#autoscrolling,

                    autoscroll_waiting:
                        this.#autoscrollWaiting
                }
            );
        }

        //#endregion


        this.#animationFrame =
            requestAnimationFrame(
                nextTime =>
                    this.#loop(nextTime)
            );
    }

    //#endregion


    //#region Rendering

    /**
     * Positions, scales, and fades every child based
     * on its (possibly fractional, possibly wrapped)
     * distance from `position`.
     *
     * Geometry contract:
     *  - Items are laid out along `stack_alignment`
     *    ('horizontal' | 'vertical').
     *  - Slot pitch for an item = that item's own
     *    measured size + items_separation (unscaled —
     *    "item is rendered, separated, then scaled").
     *  - Scale falls off as items_scale_mult ** |distance|,
     *    computed unconditionally for every item.
     *  - Opacity falls off the same way (items_alpha_mult
     *    ** |distance|) inside the "rendered" zone
     *    (|distance| <= maxRendered, where maxRendered =
     *    floor(exposed_items / 2)), then LINEARLY BLENDS
     *    that falloff value toward 0 across the one-slot
     *    band between maxRendered and the first fully
     *    invisible slot (maxRendered + 1), instead of
     *    hard-clamping to 0 the instant the bound is
     *    crossed. Because this is keyed off absolute
     *    distance, the same blend band naturally applies
     *    on both sides (upper-unrendered above, lower-
     *    unrendered below).
     *  - Cross-axis alignment (items_alignment) offsets
     *    each item within the container's cross axis.
     */
    #render(position) {

        const children =
            this.#realChildren();

        const itemCount =
            children.length;

        if (itemCount === 0) {
            return;
        }

        const horizontal =
            this.#config.stack_alignment
            === 'horizontal';

        const halfExposed =
            this.#config.exposed_items / 2;

        // Boundaries of the opacity blend band (see
        // docstring above): everything at or inside
        // maxRendered uses the normal, un-blended
        // falloff; everything at or beyond
        // upperUnrendered is fully 0; the single slot
        // of distance between them is where the
        // falloff value gets linearly mixed with 0.
        const maxRendered =
            Math.floor(halfExposed);

        const upperUnrendered =
            maxRendered + 1;

        // Small padding beyond the visible bound so
        // scale/position are still valid (per spec,
        // scale is always computed) without doing
        // wasted work far outside the container.
        const cullPadding = 1;

        const containerRect =
            this.#DOMElement.getBoundingClientRect();

        const containerCross =
            horizontal
                ? containerRect.height
                : containerRect.width;

        // Build the list of visible SLOTS around the
        // (possibly unbounded, when wrap_items is on)
        // fractional position. Each slot is just an
        // integer near position; which real child it
        // displays is (slot mod itemCount). Because
        // position itself is never wrapped anymore
        // (see scroll()/#beginAutoscroll()), a slot's
        // distance from position is already the true
        // signed distance — no shortest-path wrap
        // logic is needed here.
        const slots =
            this.#collectVisibleSlots(
                position,
                itemCount,
                upperUnrendered + cullPadding
            );

        // Offsets are accumulated by walking the slot
        // list outward from the center in each
        // direction, using the size of whichever real
        // child each slot maps to — mirrors the old
        // per-item accumulation, just keyed by slot
        // now instead of by child element.
        const offsetsBySlot =
            this.#accumulateSlotOffsets(
                slots,
                position,
                children,
                horizontal
            );

        // Track, for each real child index, which
        // slot is CLOSEST to center — that slot gets
        // the real element. Every other slot mapping
        // to the same index gets a ghost clone.
        const closestSlotForIndex =
            new Map();

        for (const slot of slots) {

            const realIndex =
                (
                    (slot % itemCount)
                    + itemCount
                )
                % itemCount;

            const distance =
                slot - position;

            const existing =
                closestSlotForIndex.get(realIndex);

            if (
                !existing
                || Math.abs(distance)
                < Math.abs(existing.distance)
            ) {

                closestSlotForIndex.set(
                    realIndex,
                    { slot, distance }
                );
            }
        }

        // Hide every real child by default; slots
        // below will reveal the ones actually in use.
        for (const child of children) {

            child.style.opacity =
                '0';

            child.style.pointerEvents =
                'none';

            child.style.visibility =
                'hidden';
        }

        const usedGhosts =
            [];

        for (const slot of slots) {

            const realIndex =
                (
                    (slot % itemCount)
                    + itemCount
                )
                % itemCount;

            const distance =
                slot - position;

            const absDistance =
                Math.abs(distance);

            const isClosest =
                closestSlotForIndex.get(realIndex)
                    ?.slot === slot;

            const sourceChild =
                children[realIndex];

            const targetElement =
                isClosest
                    ? sourceChild
                    : this.#acquireGhost(
                        sourceChild,
                        usedGhosts.length
                    );

            usedGhosts.push(
                targetElement
            );

            if (!isClosest) {

                targetElement._ghostSourceIndex =
                    realIndex;
            }


            //#region Scale (always computed)

            const scale =
                this.#config.items_scale_mult
                ** absDistance;

            //#endregion


            //#region Opacity (blended, not hard-clamped)

            const falloff =
                this.#config.items_alpha_mult
                ** absDistance;

            let opacity;

            if (absDistance <= maxRendered) {

                // Normal zone: min-rendered to
                // max-rendered — pure falloff, no
                // blending with 0.
                opacity =
                    falloff;

            } else if (absDistance >= upperUnrendered) {

                // Fully outside the rendered range.
                opacity =
                    0;

            } else {

                // Blend band: maxRendered to
                // upperUnrendered (equivalently,
                // lower-unrendered to min-rendered on
                // the negative side — same band since
                // this is keyed off absDistance).
                // Linearly mix the falloff value with
                // 0 based on how far across the band
                // this slot sits.
                const t =
                    (absDistance - maxRendered)
                    / (upperUnrendered - maxRendered);

                opacity =
                    falloff * (1 - t);
            }

            targetElement.style.opacity =
                String(opacity);

            // Only fully-transparent slots are made
            // non-interactive. Ghost clones used to be
            // unconditionally pointer-events: none
            // regardless of opacity, which made every
            // wrapped/duplicate-looking slot silently
            // unclickable — a click there fell through to
            // whatever was behind the carousel instead of
            // registering on the item the user could
            // plainly see. Ghosts are a real, visible
            // stand-in for their source item, so they now
            // stay interactive whenever they're visible;
            // #resolveClickedRealChild() maps a click on a
            // ghost back to its real source element via
            // _ghostSource.
            targetElement.style.pointerEvents =
                opacity <= 0
                    ? 'none'
                    : '';

            targetElement.style.visibility =
                'visible';

            //#endregion


            //#region Position

            const mainOffset =
                offsetsBySlot.get(slot)
                ?? 0;

            const size =
                this.#itemSizes.get(sourceChild)
                ?? {
                    width: sourceChild.offsetWidth,
                    height: sourceChild.offsetHeight
                };

            const crossOffset =
                this.#crossAxisOffset(
                    horizontal
                        ? size.height
                        : size.width,
                    containerCross
                );

            const x =
                horizontal
                    ? mainOffset
                    : crossOffset;

            const y =
                horizontal
                    ? crossOffset
                    : mainOffset;

            targetElement.style.position =
                'absolute';

            targetElement.style.left =
                '50%';

            targetElement.style.top =
                '50%';

            targetElement.style.zIndex =
                String(
                    Math.round(
                        1000 - absDistance * 10
                    )
                );

            // Translate to center, out to the slot
            // offset, back by half the item's own
            // size (so `left/top: 50%` + this nets
            // out to the item being centered on its
            // slot), THEN scale — scale applies last
            // so separation itself is never scaled
            // down, matching "rendered, separated,
            // then scaled".
            targetElement.style.transform =
                `translate(-50%, -50%) `
                + `translate(${x}px, ${y}px) `
                + `scale(${scale})`;

            //#endregion
        }

        this.#releaseUnusedGhosts(
            usedGhosts
        );
    }

    /**
     * Returns the sorted list of unbounded integer
     * slots within `maxDistance` of the fractional
     * `position`. When position is, say, 8.3, and
     * maxDistance is 3.5, this returns slots
     * [5, 6, 7, 8, 9, 10, 11, 12] — real DOM index
     * assignment happens later via (slot mod itemCount).
     */
    #collectVisibleSlots(position, itemCount, maxDistance) {

        const slots =
            [];

        const start =
            Math.floor(position - maxDistance);

        const end =
            Math.ceil(position + maxDistance);

        for (
            let slot = start;
            slot <= end;
            slot++
        ) {

            if (
                !this.#config.wrap_items
                && (slot < 0 || slot >= itemCount)
            ) {
                continue;
            }

            slots.push(
                slot
            );
        }

        return slots;
    }

    /**
     * Given the full slot list, walks outward from
     * `position` in each direction accumulating slot
     * pitch (real child's own size + items_separation)
     * so items of differing sizes still line up
     * edge-to-edge-plus-separation. Returns a
     * Map<slot, offsetPx>.
     */
    #accumulateSlotOffsets(slots, position, children, horizontal) {

        const itemCount =
            children.length;

        const offsets =
            new Map();

        if (itemCount === 0 || slots.length === 0) {
            return offsets;
        }

        const forward =
            slots
                .filter(s => s >= position)
                .sort((a, b) => a - b);

        const backward =
            slots
                .filter(s => s < position)
                .sort((a, b) => b - a);

        for (
            const [dirSlots, dir]
            of [[forward, 1], [backward, -1]]
        ) {

            let cursor = 0;
            let prevSlot = null;

            for (const slot of dirSlots) {

                const realIndex =
                    (
                        (slot % itemCount)
                        + itemCount
                    )
                    % itemCount;

                const child =
                    children[realIndex];

                const size =
                    this.#itemSizes.get(child)
                    ?? {
                        width: child.offsetWidth,
                        height: child.offsetHeight
                    };

                const mainSize =
                    horizontal
                        ? size.width
                        : size.height;

                const pitch =
                    mainSize
                    + this.#separationPx;

                if (prevSlot === null) {

                    // First step out from position may
                    // be fractional (position itself is
                    // usually not an integer mid-scroll).
                    const fraction =
                        dir > 0
                            ? slot - position
                            : position - slot;

                    cursor =
                        dir
                        * fraction
                        * pitch;

                } else {

                    cursor +=
                        dir * pitch;
                }

                offsets.set(
                    slot,
                    cursor
                );

                prevSlot =
                    slot;
            }
        }

        return offsets;
    }

    /**
     * Returns a ghost <div> (or the source element's
     * tag) visually mirroring `sourceChild`, reusing a
     * pooled clone at `poolIndex` when one already
     * exists so we're not constantly creating/
     * destroying DOM nodes every frame.
     *
     * NOTE: poolIndex is currently just "how many
     * ghosts/real elements have been placed so far
     * this frame" (insertion order), not a stable slot
     * identity. That means if the set of slots needing
     * ghosts shifts frame to frame, a given pool index
     * may end up backing a different source child than
     * last frame, causing an avoidable clone
     * teardown+recreate. Harmless for correctness, but
     * worth revisiting (e.g. keying the pool by slot
     * number instead) if profiling shows churn.
     */
    #acquireGhost(sourceChild, poolIndex) {

        let ghost =
            this.#ghostPool[poolIndex];

        if (
            !ghost
            || ghost._ghostSource !== sourceChild
        ) {

            if (ghost) {
                ghost.remove();
            }

            ghost =
                sourceChild.cloneNode(
                    true
                );

            ghost._ghostSource =
                sourceChild;

            // aria-hidden keeps screen readers and
            // sequential (Tab-order) keyboard navigation
            // from ever landing on what is, semantically, a
            // duplicate of an item that already exists
            // elsewhere in the DOM. `inert` USED to be set
            // here too, but `inert` also unconditionally
            // removes an element from pointer hit-testing at
            // the browser level (per spec), which is what
            // made every ghost slot silently unclickable no
            // matter what pointer-events value #render() set
            // on it each frame. Ghosts are dropped into
            // #ghostContainer, which itself carries no
            // interactive semantics, and any interactive
            // descendants (e.g. a <button> inside a card)
            // are neutralized individually below instead —
            // that preserves "don't let real keyboard/AT
            // users reach the duplicate" while still letting
            // MOUSE clicks land on it, since a ghost is a
            // real, visible stand-in the user can see and
            // expects to be able to click.
            ghost.setAttribute(
                'aria-hidden',
                'true'
            );

            for (
                const interactive
                of ghost.querySelectorAll(
                    'a, button, input, select, textarea, [tabindex]'
                )
            ) {

                interactive.setAttribute(
                    'tabindex',
                    '-1'
                );
            }

            ghost.style.willChange =
                'transform, opacity';

            ghost.style.transformOrigin =
                'center center';

            ghost.removeAttribute(
                'id'
            );

            this.#ghostContainer.appendChild(
                ghost
            );

            this.#ghostPool[poolIndex] =
                ghost;

        } else {

            // Keep a stale clone's *content* in sync
            // in case the source element's innerHTML
            // changed since the clone was made (e.g.
            // dynamic item content).
            if (
                ghost.innerHTML
                !== sourceChild.innerHTML
            ) {

                ghost.innerHTML =
                    sourceChild.innerHTML;
            }
        }

        return ghost;
    }

    /**
     * Hides (but keeps pooled, for reuse) any ghost
     * clones not referenced in this frame's render.
     */
    #releaseUnusedGhosts(usedElements) {

        const usedSet =
            new Set(usedElements);

        for (const ghost of this.#ghostPool) {

            if (
                ghost
                && !usedSet.has(ghost)
            ) {

                ghost.style.opacity =
                    '0';

                ghost.style.visibility =
                    'hidden';

                ghost.style.pointerEvents =
                    'none';
            }
        }
    }

    /**
     * Cross-axis pixel offset (from container center)
     * for an item of `itemCrossSize` inside a container
     * whose cross-axis size is `containerCross`, based
     * on items_alignment.
     */
    #crossAxisOffset(itemCrossSize, containerCross) {

        switch (this.#config.items_alignment) {

            case 'start':
                return (
                    -containerCross / 2
                    + itemCrossSize / 2
                );

            case 'end':
                return (
                    containerCross / 2
                    - itemCrossSize / 2
                );

            case 'center':
            default:
                return 0;
        }
    }

    /**
     * Resolves a CSS length string (e.g. '1rem',
     * '2em', '10px', '5%') to a pixel number by
     * applying it to a hidden probe element and
     * reading back its computed layout size.
     */
    #resolveLength(value) {

        if (typeof value === 'number') {
            return value;
        }

        // CSS `width` can never be negative — setting it
        // to e.g. '-10rem' is simply rejected by the
        // browser, leaving the probe at 0. To support
        // negative separations (cards overlapping instead
        // of gapping), strip the sign, resolve the
        // magnitude against a valid positive width, then
        // re-apply the sign to the resolved pixel value.
        const trimmed =
            typeof value === 'string'
                ? value.trim()
                : value;

        const negative =
            typeof trimmed === 'string'
            && trimmed.startsWith('-');

        const magnitude =
            negative
                ? trimmed.slice(1).trim()
                : trimmed;

        const probe =
            document.createElement('div');

        probe.style.position =
            'absolute';

        probe.style.visibility =
            'hidden';

        probe.style.pointerEvents =
            'none';

        probe.style.width =
            magnitude;

        // Attach inside this element so relative
        // units (em, %, etc.) resolve against the
        // same context the real items will use.
        this.#DOMElement.appendChild(
            probe
        );

        const resolved =
            probe.getBoundingClientRect().width;

        probe.remove();

        return negative
            ? -resolved
            : resolved;
    }

    /**
     * One-time per-child style setup needed for the
     * absolute-positioned rendering model.
     */
    #prepareChild(child) {

        if (
            !(child instanceof HTMLElement)
        ) {
            return;
        }

        child.style.position =
            'absolute';

        child.style.willChange =
            'transform, opacity';

        child.style.transformOrigin =
            'center center';
    }

    //#endregion


    //#region Scroll

    scroll(
        justification,
        amount = 1,
        relative = true
    ) {

        if (
            !this.#config.scroll_justification.includes(
                justification
            )
        ) {
            return;
        }

        const itemCount =
            this.#realChildren().length;

        if (itemCount === 0) {
            return;
        }


        //#region Stop Autoscroll In Place

        if (
            this.#autoscrolling
            && this.#scrolling
        ) {

            // Stop exactly where the autoscroll
            // currently is (not snapped to its
            // target) — the manual scroll below then
            // starts fresh from this real position via
            // #startScrollTowardTarget(), so the two
            // motions read as one continuous scroll
            // instead of "jump to old target, then
            // animate to new target".
            this.#stopScrollInPlace();
        }

        //#endregion


        let newItem;

        if (relative) {

            newItem =
                this.#currentItem
                + amount;

        } else if (this.#config.wrap_items) {

            // `amount` here is a bounded real child
            // index (0..itemCount-1) from a caller
            // like the click_item handler, but
            // #currentItem is unbounded. Pick whichever
            // unbounded equivalent of that real index
            // (index, index +/- itemCount, ...) is
            // closest to #currentItem, so e.g. clicking
            // "item 1" while sitting at position 9 scrolls
            // forward one slot to 8's equivalent (index 1
            // + 7) rather than jumping backward 8 slots
            // to raw index 1.
            const realIndex =
                (
                    (amount % itemCount)
                    + itemCount
                )
                % itemCount;

            const currentRealIndex =
                (
                    (this.#currentItem % itemCount)
                    + itemCount
                )
                % itemCount;

            let delta =
                realIndex - currentRealIndex;

            if (delta > itemCount / 2) {
                delta -= itemCount;
            }

            if (delta < -itemCount / 2) {
                delta += itemCount;
            }

            newItem =
                this.#currentItem
                + delta;

        } else {

            newItem =
                amount;
        }


        //#region Wrapping

        if (
            this.#config.wrap_items
        ) {

            // Intentionally NOT wrapped into
            // [0, itemCount). #currentItem and
            // #scrollTarget are allowed to grow
            // unbounded in either direction so a
            // forward scroll past the last item
            // keeps animating forward (e.g. 6 -> 7)
            // instead of snapping back to item 0 the
            // short way around. #render() is what
            // maps an unbounded slot index back to
            // a real child (via index % itemCount),
            // drawing a ghost clone for any slot
            // whose real element is already showing
            // elsewhere on screen.

        } else {

            newItem =
                Math.max(
                    0,
                    Math.min(
                        itemCount - 1,
                        newItem
                    )
                );
        }

        //#endregion


        if (
            newItem
            === this.#currentItem
        ) {
            return;
        }


        //#region Manual Scroll

        this.#currentItem =
            newItem;

        this.#scrollTarget =
            newItem;

        this.#startScrollTowardTarget();

        this.#scrolling =
            true;

        this.#autoscrolling =
            false;

        this.#autoscrollWaiting =
            false;

        //#endregion


        if (
            typeof this.#config.scroll_hook
            === 'function'
        ) {
            this.#config.scroll_hook(
                this,
                this.#currentItem
            );
        }
    }

    /**
     * Snapshots the fixed start/total distance for a
     * fresh constant-rate scroll toward #scrollTarget,
     * starting from wherever #scrollPosition currently
     * sits (which may itself be mid-scroll, e.g. a
     * manual scroll interrupting an autoscroll, or a
     * new scroll call arriving before the previous one
     * finished). Called any time #scrollTarget changes
     * and a new scroll begins.
     */
    #startScrollTowardTarget() {

        this.#scrollStartPosition =
            this.#scrollPosition;

        this.#scrollAmountTotal =
            this.#scrollTarget
            - this.#scrollStartPosition;

        this.#scrollAmountDone =
            0;
    }

    //#endregion


    //#region Autoscroll

    #beginAutoscrollWait(time) {

        if (
            this.#config.autoscroll_time < 0
        ) {
            return;
        }

        this.#autoscrollWaiting =
            true;

        this.#autoscrollWaitStart =
            time;
    }

    #beginAutoscroll() {

        if (
            this.#paused
            || this.#focused
        ) {
            return;
        }

        if (
            this.#config.autoscroll_time < 0
        ) {
            return;
        }

        const itemCount =
            this.#realChildren().length;

        if (itemCount <= 1) {
            return;
        }

        let target =
            this.#currentItem + 1;


        //#region End Of List

        if (
            target >= itemCount
            && !this.#config.wrap_items
        ) {

            this.#autoscrolling =
                false;

            this.#autoscrollWaiting =
                false;

            return;
        }

        //#endregion


        // When wrap_items is true, target is left
        // unbounded (e.g. itemCount, itemCount + 1,
        // ...) rather than wrapped back to 0 here —
        // see the note in scroll()'s Wrapping region
        // for why.


        this.#scrollTarget =
            target;

        this.#startScrollTowardTarget();

        this.#scrolling =
            true;

        this.#autoscrolling =
            true;

        this.#autoscrollWaiting =
            false;

        this.#currentItem =
            target;


        if (
            typeof this.#config.scroll_hook
            === 'function'
        ) {
            this.#config.scroll_hook(
                this,
                this.#currentItem
            );
        }
    }

    #finishAutoscroll() {

        this.#autoscrolling =
            false;

        this.#scrolling =
            false;

        this.#scrollPosition =
            this.#scrollTarget;

        if (
            !this.#paused
            && !this.#focused
            && this.#config.autoscroll_time >= 0
        ) {

            this.#beginAutoscrollWait(
                performance.now()
            );
        }
    }

    #finishScroll() {

        this.#scrolling =
            false;

        this.#scrollPosition =
            this.#scrollTarget;
    }

    /**
     * Halts an in-progress scroll EXACTLY where it
     * currently sits, without snapping position to
     * scrollTarget. This is distinct from
     * #finishAutoscroll()/#finishScroll(), which are
     * for natural completion (where scrollAmountDone
     * has already reached scrollAmountTotal, so
     * "snap to target" and "stop in place" are the
     * same thing). Interrupting mid-flight — e.g.
     * focusing, pausing, or issuing a new manual
     * scroll while an autoscroll is still animating —
     * previously called #finishAutoscroll() instead,
     * which fast-forwarded #scrollPosition all the way
     * to #scrollTarget: a visible instant jump rather
     * than a stop. This keeps #scrollPosition (and the
     * #currentItem/#scrollTarget bookkeeping) at
     * wherever the animation actually was.
     */
    #stopScrollInPlace() {

        this.#scrolling =
            false;

        this.#autoscrolling =
            false;

        this.#autoscrollWaiting =
            false;

        // #scrollPosition is left untouched — that IS
        // the "stop in place" behavior. But
        // #currentItem/#scrollTarget were tracking the
        // slot we were scrolling TOWARD; snap those
        // back to whichever slot #scrollPosition is
        // actually nearest to, so later relative
        // scrolls (which are computed off #currentItem)
        // don't disagree with where the carousel
        // visually stopped.
        const nearest =
            Math.round(
                this.#scrollPosition
            );

        this.#currentItem =
            nearest;

        this.#scrollTarget =
            nearest;

        this.#scrollAmountTotal =
            0;

        this.#scrollAmountDone =
            0;
    }

    //#endregion


    //#region Attribute Parsing

    #parseAttribute(
        value,
        preset
    ) {

        if (preset === null) {

            return value === 'null'
                ? null
                : value;
        }

        if (typeof preset === 'boolean') {

            return value !== 'false';
        }

        if (typeof preset === 'number') {

            const parsed =
                Number(value);

            return Number.isNaN(parsed)
                ? preset
                : parsed;
        }

        if (Array.isArray(preset)) {

            if (
                value.trim() === ''
            ) {
                return [];
            }

            return value
                .split(',')
                .map(
                    item => item.trim()
                );
        }

        return value;
    }

    //#endregion


    //#region Initial Item

    #getInitialItem() {

        const itemCount =
            this.#realChildren().length;

        if (itemCount === 0) {
            return 0;
        }

        if (
            this.#config.selected_item
            === 'center'
        ) {
            return Math.floor(
                (itemCount - 1) / 2
            );
        }

        if (
            typeof this.#config.selected_item
            === 'number'
        ) {

            if (
                this.#config.wrap_items
            ) {

                return (
                    (
                        this.#config.selected_item
                        % itemCount
                    )
                    + itemCount
                )
                    % itemCount;
            }

            return Math.max(
                0,
                Math.min(
                    itemCount - 1,
                    this.#config.selected_item
                )
            );
        }

        return 0;
    }

    //#endregion


    //#region Focus

    focus(
        justification,
        time = -1
    ) {

        if (
            !this.#config.focus_justification.includes(
                justification
            )
        ) {
            return;
        }

        if (this.#focused) {
            return;
        }

        this.#focused =
            true;

        HTMLElement.prototype.focus.call(
            this.#DOMElement
        );


        //#region Stop Autoscroll In Place

        if (
            this.#autoscrolling
            && this.#scrolling
        ) {

            this.#stopScrollInPlace();

        } else {

            this.#autoscrolling =
                false;

            this.#autoscrollWaiting =
                false;
        }

        //#endregion


        if (
            typeof this.#config.focus_hook
            === 'function'
        ) {
            this.#config.focus_hook(
                this
            );
        }

        if (time >= 0) {

            setTimeout(
                () => {
                    this.unfocus(
                        'timeout'
                    );
                },
                time
            );
        }
    }

    unfocus(
        justification,
        time = -1
    ) {

        if (
            !this.#config.unfocus_justification.includes(
                justification
            )
        ) {
            return;
        }

        if (!this.#focused) {
            return;
        }

        this.#focused =
            false;

        HTMLElement.prototype.blur.call(
            this.#DOMElement
        );

        if (
            typeof this.#config.unfocus_hook
            === 'function'
        ) {
            this.#config.unfocus_hook(
                this
            );
        }

        if (time >= 0) {

            setTimeout(
                () => {
                    this.focus(
                        'timeout'
                    );
                },
                time
            );
        }
    }

    //#endregion


    //#region Child Selection

    child_selected(
        justification,
        child
    ) {

        if (
            !this.#config.selectItem_justification.includes(
                justification
            )
        ) {
            return;
        }

        if (!child) {
            return;
        }

        if (
            child.parentElement
            !== this.#DOMElement
        ) {
            return;
        }

        if (
            typeof this.#config.child_selected_hook
            === 'function'
        ) {
            this.#config.child_selected_hook(
                this,
                child
            );
        }
    }

    //#endregion


    //#region Pause / Play

    pause(justification) {

        if (
            !this.#config.pause_justification.includes(
                justification
            )
        ) {
            return;
        }

        if (this.#paused) {
            return;
        }


        //#region Stop Autoscroll In Place

        if (
            this.#autoscrolling
            && this.#scrolling
        ) {

            this.#stopScrollInPlace();

        } else {

            this.#autoscrolling =
                false;

            this.#autoscrollWaiting =
                false;
        }

        //#endregion


        this.#paused =
            true;

        this.#playing =
            false;

        if (
            typeof this.#config.pause_hook
            === 'function'
        ) {
            this.#config.pause_hook(
                this
            );
        }
    }

    play(justification) {

        if (
            !this.#config.play_justification.includes(
                justification
            )
        ) {
            return;
        }

        if (
            !this.#paused
        ) {
            return;
        }

        this.#paused =
            false;

        this.#playing =
            true;


        //#region Autoscroll

        if (
            !this.#focused
            && this.#config.autoscroll_time >= 0
        ) {
            this.#beginAutoscrollWait(
                performance.now()
            );
        }

        //#endregion


        if (
            typeof this.#config.play_hook
            === 'function'
        ) {
            this.#config.play_hook(
                this
            );
        }
    }

    //#endregion


    //#region Removal

    remove() {

        if (
            typeof this.#config.remove_hook
            === 'function'
        ) {
            this.#config.remove_hook(
                this
            );
        }

        Element.prototype.remove.call(
            this.#DOMElement
        );
    }

    //#endregion


    //#region Getters

    get name() {
        return this.#config.name;
    }

    get exposed_items() {
        return this.#config.exposed_items;
    }

    get selected_item() {
        return this.#currentItem;
    }

    get wrap_items() {
        return this.#config.wrap_items;
    }

    get stack_alignment() {
        return this.#config.stack_alignment;
    }

    get items_alignment() {
        return this.#config.items_alignment;
    }

    get items_separation() {
        return this.#config.items_separation;
    }

    get items_scale_mult() {
        return this.#config.items_scale_mult;
    }

    get items_alpha_mult() {
        return this.#config.items_alpha_mult;
    }

    get autoscroll_time() {
        return this.#config.autoscroll_time;
    }

    get autoscroll_speed() {
        return this.#config.autoscroll_speed;
    }

    get scroll_sensitivity() {
        return this.#config.scroll_sensitivity;
    }

    get scroll_speed() {
        return this.#config.scroll_speed;
    }

    get focused() {
        return this.#focused;
    }

    get playing() {
        return this.#playing;
    }

    get paused() {
        return this.#paused;
    }

    get scrolling() {
        return this.#scrolling;
    }

    get autoscrolling() {
        return this.#autoscrolling;
    }

    get scroll_position() {
        return this.#scrollPosition;
    }

    //#endregion
}

/*in prog
class Menu extends HTMLElement {

    //#region State

    #DOMElement = this;
    #config = {};
    #initialized = false;

    #collapsed = false;
    #exposed = [];

    //#endregion


    //#region Lifecycle

    constructor(config = {}) {
        super();

        const presets = {
            title_items: 1,

            collapse_structure: {
                layout: 'vertical_list',
                structure: 1
            }, 
            //vertical_list | [numb_columns]
            //horizontal_list | [numb_rows]
            //bound_grid | [columns],[rows],[overflow_behavior: cutoff | new_page]
            

            expand_justifiers: ['focus'],
            collapse_justifiers: ['unfocus'],

            focus_justifier: ['mouse_enter', 'click'],
            unfocus_justifier: ['mouse_exit', 'unclick'],
            
            hidden_opacity: 0,
            opacity_adjust_time: 1,

            collapse_children_handling: 'hide', //cutoff, shrink
            collapse_size_handling: 'shrink', //snap, fade


            collapsed: false,
            focused: false,

            expand_hook: null,
            collapse_hook: null,

            focus_hook: null,
            unfocus_hook: null,

            overflow_hook: null,
            scollpage_hook: null,

            init_hook: null,
            delete_hook: null
        };

        for (
            const [parameter, preset]
            of Object.entries(presets)
        ) {

            const camelCaseParameter =
                parameter.replace(
                    /_([a-z])/g,
                    (_, letter) =>
                        letter.toUpperCase()
                );

            if (
                config[camelCaseParameter]
                !== undefined
            ) {
                this.#config[parameter] =
                    config[camelCaseParameter];

                continue;
            }

            if (
                this[camelCaseParameter]
                !== undefined
            ) {
                this.#config[parameter] =
                    this[camelCaseParameter];

                continue;
            }

            this.#config[parameter] =
                preset;
        }

        this.#collapsed =
            this.#config.collapsed;

        if (this.#collapsed) {
            this.collapse();
        } else {
            this.expand();
        }
    }


    connectedCallback() {
        this.#initialize();
    }


    disconnectedCallback() {

        if (
            typeof this.#config.delete_hook
            === 'function'
        ) {
            this.#config.delete_hook.call(
                this
            );
        }
    }


    #initialize() {

        if (this.#initialized) {
            return;
        }

        this.#initialized = true;

        if (
            typeof this.#config.init_hook
            === 'function'
        ) {
            this.#config.init_hook.call(
                this
            );
        }
    }

    //#endregion


    //#region Configuration

    get collapse_items() {
        return this.#config.collapse_items;
    }


    get collapse_structure() {
        return this.#config.collapse_structure;
    }


    get collapsed() {
        return this.#collapsed;
    }


    get collapse_hook() {
        return this.#config.collapse_hook;
    }


    get expand_hook() {
        return this.#config.expand_hook;
    }


    get init_hook() {
        return this.#config.init_hook;
    }


    get delete_hook() {
        return this.#config.delete_hook;
    }


    get exposed_items() {
        return this.#exposed;
    }

    //#endregion


    //#region Collapse

    collapse() {

        if (this.#collapsed) {
            return;
        }

        this.#collapsed = true;

        this.#exposed =
            [...this.children].slice(
                0,
                this.#config.collapse_items
            );

        if (
            typeof this.#config.collapse_hook
            === 'function'
        ) {
            this.#config.collapse_hook.call(
                this
            );
        }
    }


    expand() {

        if (!this.#collapsed) {
            this.#exposed =
                [...this.children];

            return;
        }

        this.#collapsed = false;

        this.#exposed =
            [...this.children];

        if (
            typeof this.#config.expand_hook
            === 'function'
        ) {
            this.#config.expand_hook.call(
                this
            );
        }
    }

    //#endregion
}
*/


customElements.define(
    'tidbit-carousel',
    Carousel
);

/*in prog
customElements.define(
    'tidbit-menu',
    Menu
);
*/