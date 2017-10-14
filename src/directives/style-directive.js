import nextTick from "common-micro-libs/src/jsutils/nextTick"
import {
    watchProp,
    observableAssign,
    setDependencyTracker,
    unsetDependencyTracker,
    stopDependeeNotifications } from "observable-data/src/ObservableObject"
import {
    PRIVATE,
    escapeString,
    bindCallTo }    from "../utils"
import Directive    from "./Directive"

//============================================
const DIRECTIVE             = "b:style";
const ELEMENT_PROTOTYPE     = Element.prototype;

const getAttribute          = bindCallTo(ELEMENT_PROTOTYPE.getAttribute);
const removeAttribute       = bindCallTo(ELEMENT_PROTOTYPE.removeAttribute);
const matchesDirective      = new RegExp(`^${ escapeString(DIRECTIVE) }$`);

const StyleDirective = Directive.extend({
    init(ele) {
        let cssStyleList        = {};
        let updateAlreadyQueued = false;
        let domEleUpdateQueued  = false;
        let dataForGetter       = {};
        const eleStyleList      = ele.style;
        const directive         = this.directive;
        const directiveValue    = getAttribute(ele, directive);
        let tokenValueGetter    = new Function("d", `with (d) {return ${ directiveValue };}`);
        const updater = data => {
            if (data) {
                stopDependeeNotifications(updater);
                dataForGetter = data;
            }
            if (updateAlreadyQueued) {
                return;
            }
            updateAlreadyQueued = true;
            nextTick(() => {
                setDependencyTracker(updater);
                try {
                    observableAssign(cssStyleList, tokenValueGetter(dataForGetter));
                }
                catch(e) {
                    console.error(e);
                }
                unsetDependencyTracker(updater);
                updateAlreadyQueued = false;
            });
        };
        const applyStylesToDomEle = () => {
            if (domEleUpdateQueued) {
                return;
            }
            domEleUpdateQueued = true;
            nextTick(() => {
                Object.keys(cssStyleList).forEach(styleProp => {
                    if (eleStyleList[styleProp] !== cssStyleList[styleProp]) {
                        eleStyleList[styleProp] = cssStyleList[styleProp];
                    }
                });
                domEleUpdateQueued = false;
            });
        };
        const inst = { updater };

        inst.classObjEv = watchProp(cssStyleList, cssStyleList, applyStylesToDomEle);
        removeAttribute(ele, directive);
        PRIVATE.set(this, inst);

        this.onDestroy(() => {
            stopDependeeNotifications(updater);
            this.getFactory().getDestroyCallback(inst, PRIVATE)();
            cssStyleList = dataForGetter = tokenValueGetter = null;
        });
    },

    get directive() {
        return DIRECTIVE;
    }
});
export default StyleDirective;

/**
 * Static method that allows to check if a given string matches this directive's string
 *
 * @method StyleDirective#is
 *
 * @param {String} directive
 *
 * @returns {boolean}
 */
StyleDirective.is = function(directive) {
    return matchesDirective.test(directive.trim());
};