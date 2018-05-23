import Map from "common-micro-libs/src/jsutils/es6-Map"
import {
    makeObservable,
    unsetDependencyTracker,
    objectWatchProp
} from "observables/src/objectWatchProp"
import {arrayWatch} from "observables/src/arrayWatch"
import Directive from "./Directive"
import {
    PRIVATE,
    DOM_DATA_BIND_PROP,
    hasAttribute,
    getAttribute,
    removeAttribute,
    createComment,
    insertBefore,
    removeChild,
    createValueGetter,
    isPureObject,
    createDocFragment,
    arrayForEach, arraySlice
} from "../utils"
import {render} from "../render";

//============================================
const DIRECTIVE     = "_each";
const KEY_DIRECTIVE = "_key";
const NOOP          = () => {};
const isEmptyList   = list => {
    return (Array.isArray(list) && !list.length) || (isPureObject(list) && !Object.keys(list).length);
};

/**
 * Directive to loop through an array or object. In addition, it also support an
 * internal binding directive called `b:key`
 *
 * @class EachDirective
 * @extends Directive
 *
 * @example
 *
 * // Use with array:
 * _each="item of arrayList"
 * _each="(item, index) of arrayList"
 *
 * // Use with Object
 * _each="value of objectList"
 * _each="(value, key) of objectList"
 */
export class EachDirective extends Directive {
    static has(ele) {
        return hasAttribute(ele, DIRECTIVE) ? DIRECTIVE : "";
    }

    static manages() { return true; }


    init(attr, attrValue) {
        const [ iteratorArgs, listVar ] = parseDirectiveValue((attrValue || "").trim());
        this._attr              = attr;
        this._iteratorArgs      = iteratorArgs;
        this._tokenValueGetter  = createValueGetter((listVar || ""));
    }

    render(handler, node, data) {
        super.render(handler, node, data);
        const state = PRIVATE.get(handler);

        if (!state.update) {
            state.binders = [];
            state.bindersByKey = new Map();
            state.listIterator = () => this.iterateOverList(handler, state.value);
            state.isFirstRender = true;
            state.usesKey = false;
            state.getKey = NOOP;
            state.update = newList => {
                if (newList === state.value) {
                    return;
                }
                else if (state.value) {
                    state.value = null;

                    if (state.listIterator.stopWatchingAll) {
                        state.listIterator.stopWatchingAll();
                    }
                }

                if (!newList) {
                    this.destroyChildBinders(state.binders, handler);
                    return;
                }

                unsetDependencyTracker(state.tracker); // We don't need to be notified of changes for individual items.
                state.value = newList;

                // Make sure data is observable and setup event listners on it.
                makeObservable(newList);

                if (Array.isArray(newList)) {
                    arrayWatch(newList, state.listIterator);
                }
                else if (isPureObject(newList)) {
                    objectWatchProp(newList, null, state.listIterator);
                }

                if (isEmptyList(newList) && state.binders) {
                    this.destroyChildBinders(state.binders, handler);
                }
                else {
                    this.iterateOverList(handler, newList);
                }
            };

            // When handler is destroyed, remove data listeners
            handler.onDestroy(() => {
                if (state.listIterator.stopWatchingAll) {
                    state.listIterator.stopWatchingAll();
                }
                state.bindersByKey.clear();
                this.destroyChildBinders(state.binders, handler);
            });
        }
    }

    /**
     * Destroy the binder instances and remove Elements from DOM.
     *
     * @param binders
     * @param handler
     */
    destroyChildBinders(binders, handler) {
        if (!binders || !binders.length) {
            return;
        }

        binders = binders.splice(0);

        if (handler._isSoleChild) {
            const parentEle = handler._placeholderEle.parentNode;
            parentEle.textContent = "";
            parentEle.appendChild(handler._placeholderEle);
            setTimeout(() => {
                arrayForEach(binders.splice(0), binder => binder.destroy())
            });
        }
        else {
            arrayForEach(binders.splice(0), binder => binder._destroy());
        }
    }

    /**
     * Returns an object (`dataObj` if provided on input) with additional keys - each
     * one being the argNames that the user defined in their HTML `_each` template.
     *
     * It essentially matches up two array by using the keys from one array and mapping to
     * values from the second array at exactly the same location.
     * Example:
     *
     *      _each="item in arrayList"
     *      arrayList = [ "value 1" ]
     *
     *      // Array Keys           // Array values             // result: object
     *      // Defined in the       // Data in actual           // Matches the key
     *      // template             // Array                    // to the data
     *      //-------------------   //-----------------         //---------------------
     *      [                       [                   ===     {
     *          "item"                  "value 1"       ===         item: "value1"
     *      ]                       ]                   ===     }
     *
     * @param {Array} values
     * @param {Object} [dataObj]
     *
     * @returns {Object}
     */
    getDataForIteration(values, dataObj) {
        return this._iteratorArgs.reduce(
            (rowData, argName) => {
                rowData[argName] = values.shift();
                return rowData;
            },
            dataObj || {}
        );
    }

    /**
     * Iterates over a new set (list) and eitehr updates or builds out new elements for each item
     * in that list.
     *
     * @param handler
     * @param newData
     */
    iterateOverList(handler, newData) {
        const state             = PRIVATE.get(handler);
        const attachedEleBinder = [];
        const newDomElements    = createDocFragment();
        let isArray             = Array.isArray(newData);
        let data;

        if (isArray) {
            isArray = true;
            data = newData;
        }
        else if (isPureObject(newData)) {
            data = Object.keys(newData);
        } else {
            return;
        }

        for (let i = 0, t = data.length; i < t; i++) {
            let rowData = { $data: state.data.$data || state.data };

            if (isArray) {
                this.getDataForIteration([ data[i], i ], rowData);
            }
            else {
                this.getDataForIteration([ newData[ data[i] ], data[i], i ], rowData);
            }

            const binder = this.getRowBinder(handler, rowData);
            binder._loop.pos = i;
            attachedEleBinder.push(binder);
            newDomElements.appendChild(binder);
        }

        if (newDomElements.hasChildNodes()) {
            insertBefore(handler._placeholderEle.parentNode, newDomElements, handler._placeholderEle);
        }

        // store the new attached set of elements in their new positions, and
        // clean up old Binders that are no longer being used/displayed
        // FIXME: this needs to be more efficient!!!!!!
        arrayForEach(state.binders.splice(0, state.binders.length, ...attachedEleBinder), childBinder => {
            if (attachedEleBinder.indexOf(childBinder) === -1) {
                childBinder._destroy();
            }
        });

        if (state.binders.length) {
            this.positionChildren(
                handler._placeholderEle.parentNode,
                handler._placeholderEle,
                state.binders
            );
        }
    }

    /**
     * Handles processing a single data item by either updating and existing binder or creating
     * a new binder.
     *
     * @param {NodeHandler} handler
     * @param {Object} rowData
     *
     * @returns {Template}
     *  returns an array wtih two values:
     *  -   the binder for the data item (could be an exising one)
     *  -   Document fragment containing any new Elements that should be inserted into dom
     */
    getRowBinder(handler, rowData) {
        const state     = PRIVATE.get(handler);
        let itemBinder  = null;
        let rowKey      = state.getKey(rowData);
        let rowEleBinder;

        if (rowKey) {
            rowEleBinder = state.bindersByKey.get(rowKey);
        }

        // If a binder already exists for this key, then just update its data
        if (rowEleBinder) {
            delete rowData.$data;
            rowEleBinder[DOM_DATA_BIND_PROP].setData(rowData);
            itemBinder = rowEleBinder;
            return itemBinder;
        }

        // Render a new Element from the template and store the nodes that are
        // created by it (needed for later).
        rowEleBinder = render(handler._n.data, rowData, handler._directives);

        // Is it first render? if so, then we need to determine if the DOM element
        // that was rendered has the _key attribute
        if (state.isFirstRender) {
            state.isFirstRender = false;

            if (
                rowEleBinder.childNodes.length === 1 &&
                rowEleBinder.firstChild.nodeType === 1 &&
                hasAttribute(rowEleBinder.firstChild, KEY_DIRECTIVE)
            ) {
                state.usesKey = true;
                state.getKey = createValueGetter(getAttribute(rowEleBinder.firstChild, KEY_DIRECTIVE));
                rowKey = state.getKey();
            }
        }

        if (state.usesKey) {
            removeAttribute(rowEleBinder.firstChild, KEY_DIRECTIVE);
        }

        rowEleBinder._children = arraySlice(rowEleBinder.childNodes, 0);
        rowEleBinder._destroy = destroyRowElement;
        rowEleBinder._state = state;
        rowEleBinder._loop  = { rowEle: rowEleBinder, rowKey, pos: -1 };

        if (rowKey) {
            state.bindersByKey.set(rowKey, rowEleBinder);
        }

        itemBinder = rowEleBinder;
        return itemBinder;
    }

    /**
     *
     * @param {HTMLElement} eleParentNode
     * @param {HTMLElement} placeholderEle
     * @param {Array} childEleBinders
     */
    positionChildren(eleParentNode, placeholderEle, childEleBinders) {
        // FIXME: speed improvement = convert to while() looop
        arrayForEach(childEleBinders, (childBinder, index) => {
            if (childBinder._loop.pos === index) {
                return;
            }

            insertBefore(
                eleParentNode,
                childBinder._loop.rowEle,
                childEleBinders[index + 1] ? childEleBinders[index + 1]._loop.rowEle : placeholderEle
            );
            childBinder._loop.pos = index;
        });
    }

    getNodeHandler(node, directives) {
        const handler           = super.getNodeHandler(node);
        handler._directives     = directives;
        handler._placeholderEle = createComment("");
        handler.getKey          = NOOP;
        // FIXME: need a way to get _key from template (comment)
        // hasAttribute(node, KEY_DIRECTIVE) ? createValueGetter(getAttribute(node, KEY_DIRECTIVE)) : NOOP;
        handler._isSoleChild    = hasDedicatedParent(node);

        insertBefore(node.parentNode, handler._placeholderEle, node);
        removeChild(node.parentNode, node);
        // removeAttribute(node, KEY_DIRECTIVE);

        return handler;
    }
}

function destroyRowElement () {
    // this === DocumentFragment from `render()`

    // remove all elements/nodes of this row from DOM
    for (let i = 0, t = this._children.length; i < t; i++) {
        this._children[i].parentNode && this._children[i].parentNode.removeChild(this._children[i]);
    }

    if (this._loop.rowKey) {
        this._state.bindersByKey.delete(this._loop.rowKey);
    }

    this._state = null;
    this[DOM_DATA_BIND_PROP].destroy();
}

function parseDirectiveValue(attrValue) {
    let matches = /\(?(.+?)\)?\W?(?:of|in)\W(.*)/.exec(attrValue);
    if (matches) {
        matches = matches.slice(1);
        matches[0] = matches[0].split(/\,/).map(argName => String(argName).trim());
        return matches;
    }
    return [];
}

function hasDedicatedParent(node) {
    return Array.prototype.every.call(node.parentNode.childNodes, childNode => {
        return childNode === node || (childNode.nodeType === 3 && !childNode.textContent.trim());
    });
}


export default EachDirective;
