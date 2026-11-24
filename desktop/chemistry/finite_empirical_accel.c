#define PY_SSIZE_T_CLEAN
#include <Python.h>
#include <math.h>

typedef struct {
    double x, y, z, radius;
    Py_ssize_t element;
    int is_metal, is_hydrogen;
} Atom;

static PyObject *measure(PyObject *unused, PyObject *args) {
    (void)unused;
    PyObject *positions, *rows, *radii, *metadata, *limits, *hypot;
    PyObject *cov = NULL, *coord = NULL, *weak = NULL, *result = NULL;
    Atom *atoms = NULL;
    if (!PyArg_ParseTuple(args, "O!O!O!O!O!O", &PyList_Type, &positions,
                          &PyList_Type, &rows, &PyList_Type, &radii,
                          &PyList_Type, &metadata, &PyTuple_Type, &limits, &hypot)) {
        return NULL;
    }
    Py_ssize_t n = PyList_GET_SIZE(positions);
    Py_ssize_t types = PyTuple_GET_SIZE(limits);
    if (n != PyList_GET_SIZE(rows) || n != PyList_GET_SIZE(radii) || n != PyList_GET_SIZE(metadata)
        || n > PY_SSIZE_T_MAX / (Py_ssize_t)sizeof(Atom)) {
        PyErr_SetString(PyExc_ValueError, "Invalid empirical atom inventory");
        return NULL;
    }
    for (Py_ssize_t i = 0; i < types; ++i) {
        PyObject *line = PyTuple_GET_ITEM(limits, i);
        if (!PyTuple_CheckExact(line) || PyTuple_GET_SIZE(line) != types) {
            PyErr_SetString(PyExc_ValueError, "Invalid empirical limit table");
            return NULL;
        }
        for (Py_ssize_t j = 0; j < types; ++j) {
            if (!PyFloat_CheckExact(PyTuple_GET_ITEM(line, j))) {
                PyErr_SetString(PyExc_ValueError, "Invalid empirical limit value");
                return NULL;
            }
        }
    }
    atoms = PyMem_Malloc((size_t)n * sizeof(Atom));
    if (atoms == NULL) return PyErr_NoMemory();
    for (Py_ssize_t i = 0; i < n; ++i) {
        PyObject *xyz = PyList_GET_ITEM(positions, i);
        PyObject *meta = PyList_GET_ITEM(metadata, i);
        if (!PyTuple_CheckExact(xyz) || PyTuple_GET_SIZE(xyz) != 3 ||
            !PyTuple_CheckExact(meta) || PyTuple_GET_SIZE(meta) != 3) {
            PyErr_SetString(PyExc_ValueError, "Invalid empirical atom row");
            goto done;
        }
        Atom *atom = &atoms[i];
        atom->x = PyFloat_AsDouble(PyTuple_GET_ITEM(xyz, 0));
        atom->y = PyFloat_AsDouble(PyTuple_GET_ITEM(xyz, 1));
        atom->z = PyFloat_AsDouble(PyTuple_GET_ITEM(xyz, 2));
        atom->radius = PyFloat_AsDouble(PyList_GET_ITEM(radii, i));
        atom->element = PyLong_AsSsize_t(PyTuple_GET_ITEM(meta, 0));
        atom->is_metal = PyTuple_GET_ITEM(meta, 1) == Py_True;
        atom->is_hydrogen = PyTuple_GET_ITEM(meta, 2) == Py_True;
        if (PyErr_Occurred()) goto done;
        if (atom->element < 0 || atom->element >= types || !isfinite(atom->radius) ||
            atom->radius <= 0 || !isfinite(atom->x) || !isfinite(atom->y) || !isfinite(atom->z)) {
            PyErr_SetString(PyExc_ValueError, "Invalid empirical atom geometry or type");
            goto done;
        }
    }
    cov = PyDict_New(); coord = PyDict_New(); weak = PyDict_New();
    if (!cov || !coord || !weak) goto done;
    for (Py_ssize_t i = 0; i < n; ++i) {
        const Atom *a = &atoms[i];
        PyObject *row = PyList_GET_ITEM(rows, i);
        if (!PyTuple_CheckExact(row)) {
            PyErr_SetString(PyExc_ValueError, "Invalid empirical neighbor row");
            goto done;
        }
        for (Py_ssize_t k = 0; k < PyTuple_GET_SIZE(row); ++k) {
            PyObject *right = PyTuple_GET_ITEM(row, k);
            Py_ssize_t j = PyLong_AsSsize_t(right);
            if (PyErr_Occurred()) goto done;
            if (j < 0 || j >= n) {
                PyErr_SetString(PyExc_ValueError, "Invalid empirical neighbor index");
                goto done;
            }
            if (j <= i) continue;
            const Atom *b = &atoms[j];
            PyObject *xyz[3] = {PyFloat_FromDouble(a->x - b->x), PyFloat_FromDouble(a->y - b->y),
                                PyFloat_FromDouble(a->z - b->z)};
            PyObject *norm = NULL;
            if (xyz[0] && xyz[1] && xyz[2]) norm = PyObject_Vectorcall(hypot, xyz, 3, NULL);
            Py_XDECREF(xyz[0]); Py_XDECREF(xyz[1]); Py_XDECREF(xyz[2]);
            if (norm == NULL) goto done;
            if (!PyFloat_CheckExact(norm)) {
                Py_DECREF(norm);
                PyErr_SetString(PyExc_ValueError, "Invalid empirical distance");
                goto done;
            }
            double distance = PyFloat_AS_DOUBLE(norm);
            double ratio = distance / (a->radius + b->radius);
            int metal = a->is_metal || b->is_metal;
            if (ratio < 0.55 || ratio > (metal ? 1.55 : 1.28)) {
                Py_DECREF(norm);
                continue;
            }
            double score = 2 * ((metal ? 1.30 : 1.22) - ratio);
            if (score <= 0) {
                Py_DECREF(norm);
                continue;
            }
            PyObject *target = metal ? coord : cov;
            if (!metal && !a->is_hydrogen && !b->is_hydrogen &&
                distance > PyFloat_AS_DOUBLE(PyTuple_GET_ITEM(PyTuple_GET_ITEM(limits, a->element), b->element))) {
                target = weak;
            }
            PyObject *left = PyLong_FromSsize_t(i);
            PyObject *pair = left ? PyTuple_Pack(2, left, right) : NULL;
            PyObject *grade = PyFloat_FromDouble(score);
            PyObject *value = grade ? PyTuple_Pack(2, norm, grade) : NULL;
            int inserted = pair && value ? PyDict_SetItem(target, pair, value) : -1;
            Py_XDECREF(left); Py_XDECREF(pair); Py_XDECREF(grade); Py_XDECREF(value); Py_DECREF(norm);
            if (inserted < 0) goto done;
        }
    }
    result = PyTuple_Pack(3, cov, coord, weak);
done:
    PyMem_Free(atoms);
    Py_XDECREF(cov); Py_XDECREF(coord); Py_XDECREF(weak);
    return result;
}

static Py_ssize_t representative(Py_ssize_t *parents, Py_ssize_t item) {
    while (parents[item] != item) {
        parents[item] = parents[parents[item]];
        item = parents[item];
    }
    return item;
}

static PyObject *components(PyObject *unused, PyObject *args) {
    (void)unused;
    Py_ssize_t n;
    PyObject *orders;
    if (!PyArg_ParseTuple(args, "nO!", &n, &PyDict_Type, &orders)) return NULL;
    if (n < 0 || n > PY_SSIZE_T_MAX / (Py_ssize_t)sizeof(PyObject *)) {
        PyErr_SetString(PyExc_ValueError, "Invalid empirical graph size");
        return NULL;
    }
    if (!n && !PyDict_Size(orders)) return PyList_New(0);
    Py_ssize_t *parents = PyMem_Malloc((size_t)n * sizeof(Py_ssize_t));
    char *touched = PyMem_Calloc((size_t)n, 1);
    PyObject **groups = PyMem_Calloc((size_t)n, sizeof(PyObject *));
    PyObject *result = NULL, *component_list = PyList_New(0);
    if (!parents || !touched || !groups || !component_list) {
        PyErr_NoMemory();
        goto done;
    }
    for (Py_ssize_t i = 0; i < n; ++i) parents[i] = i;
    Py_ssize_t cursor = 0;
    PyObject *pair, *order;
    while (PyDict_Next(orders, &cursor, &pair, &order)) {
        if (!PyTuple_CheckExact(pair) || PyTuple_GET_SIZE(pair) != 2) {
            PyErr_SetString(PyExc_ValueError, "Invalid empirical graph edge");
            goto done;
        }
        Py_ssize_t a = PyLong_AsSsize_t(PyTuple_GET_ITEM(pair, 0));
        if (PyErr_Occurred()) goto done;
        Py_ssize_t b = PyLong_AsSsize_t(PyTuple_GET_ITEM(pair, 1));
        if (PyErr_Occurred()) goto done;
        if (a < 0 || a >= n || b < 0 || b >= n) {
            PyErr_SetString(PyExc_ValueError, "Invalid empirical graph edge index");
            goto done;
        }
        touched[a] = touched[b] = 1;
        a = representative(parents, a);
        b = representative(parents, b);
        if (a < b) parents[b] = a;
        else if (b < a) parents[a] = b;
    }
    for (Py_ssize_t i = 0; i < n; ++i) {
        if (!touched[i]) continue;
        Py_ssize_t root = representative(parents, i);
        if (!groups[root]) {
            PyObject *indices = PyList_New(0), *edges = PyDict_New();
            PyObject *group = indices && edges ? PyTuple_Pack(2, indices, edges) : NULL;
            Py_XDECREF(indices); Py_XDECREF(edges);
            if (!group) goto done;
            int ok = PyList_Append(component_list, group);
            if (ok == 0) groups[root] = group;
            Py_DECREF(group);
            if (ok < 0) goto done;
        }
        PyObject *index = PyLong_FromSsize_t(i);
        if (!index) goto done;
        int ok = PyList_Append(PyTuple_GET_ITEM(groups[root], 0), index);
        Py_DECREF(index);
        if (ok < 0) goto done;
    }
    cursor = 0;
    while (PyDict_Next(orders, &cursor, &pair, &order)) {
        Py_ssize_t a = PyLong_AsSsize_t(PyTuple_GET_ITEM(pair, 0));
        Py_ssize_t root = representative(parents, a);
        if (PyDict_SetItem(PyTuple_GET_ITEM(groups[root], 1), pair, order) < 0) goto done;
    }
    result = component_list;
    component_list = NULL;
done:
    PyMem_Free(parents); PyMem_Free(touched); PyMem_Free(groups); Py_XDECREF(component_list);
    return result;
}

static PyObject *copy_atoms(PyObject *unused, PyObject *args) {
    (void)unused;
    PyObject *atoms, *deepcopy;
    if (!PyArg_ParseTuple(args, "O!O", &PyList_Type, &atoms, &deepcopy)) return NULL;
    Py_ssize_t n = PyList_GET_SIZE(atoms);
    PyObject *result = PyList_New(n);
    if (!result) return NULL;
    for (Py_ssize_t i = 0; i < n; ++i) {
        PyObject *atom = PyList_GET_ITEM(atoms, i), *key, *value;
        Py_ssize_t cursor = 0;
        int flat = PyDict_CheckExact(atom);
        while (flat && PyDict_Next(atom, &cursor, &key, &value)) {
            if (!PyUnicode_CheckExact(value) && !PyLong_CheckExact(value) && !PyFloat_CheckExact(value)
                && !PyBool_Check(value) && value != Py_None) { flat = 0; break; }
        }
        PyObject *output = flat ? PyDict_Copy(atom) : PyObject_CallOneArg(deepcopy, atom);
        if (!output) { Py_DECREF(result); return NULL; }
        PyList_SET_ITEM(result, i, output);
    }
    return result;
}

static PyObject *check_rows(PyObject *unused, PyObject *args) {
    (void)unused;
    PyObject *atoms, *element_lookup;
    if (!PyArg_ParseTuple(args, "O!O", &PyList_Type, &atoms, &element_lookup)) return NULL;
    PyObject *keys[6] = {NULL};
    const char *names[6] = {"x", "y", "z", "element", "formalCharge", ""};
    PyObject *seen = PySet_New(NULL);
    PyObject *result = NULL;
    if (!seen) return NULL;
    for (size_t j = 0; j < 6; ++j) {
        keys[j] = PyUnicode_InternFromString(names[j]);
        if (!keys[j]) goto done;
    }
    for (Py_ssize_t i = 0; i < PyList_GET_SIZE(atoms); ++i) {
        PyObject *row = PyList_GET_ITEM(atoms, i);
        if (!PyDict_CheckExact(row)) {
            PyErr_SetString(PyExc_ValueError, "Invalid empirical validation row");
            goto done;
        }
        for (size_t j = 0; j < 3; ++j) {
            PyObject *number = PyDict_GetItemWithError(row, keys[j]);
            if (PyErr_Occurred()) goto done;
            if (!number || (!PyFloat_Check(number) && !PyLong_Check(number)) || PyBool_Check(number)) {
                result = PyLong_FromLong(1);
                goto done;
            }
            double value = PyFloat_AsDouble(number);
            if (PyErr_Occurred()) goto done;
            if (!isfinite(value)) { result = PyLong_FromLong(1); goto done; }
        }
        PyObject *symbol = PyDict_GetItemWithError(row, keys[3]);
        if (PyErr_Occurred()) goto done;
        if (!symbol) symbol = keys[5];
        int present = PyUnicode_CheckExact(symbol) ? PySet_Contains(seen, symbol) : 0;
        if (present < 0) goto done;
        if (!present) {
            PyObject *num = PyObject_CallOneArg(element_lookup, symbol);
            if (!num) { PyErr_Clear(); result = PyLong_FromLong(2); goto done; }
            long atnum = PyLong_AsLong(num);
            Py_DECREF(num);
            if (PyErr_Occurred()) goto done;
            if (atnum < 1) { result = PyLong_FromLong(2); goto done; }
            if (PyUnicode_CheckExact(symbol) && PySet_Add(seen, symbol) < 0) goto done;
        }
        PyObject *charge = PyDict_GetItemWithError(row, keys[4]);
        if (PyErr_Occurred()) goto done;
        if (charge && !PyLong_Check(charge)) { result = PyLong_FromLong(3); goto done; }
    }
    result = PyLong_FromLong(0);
done:
    for (size_t j = 0; j < 6; ++j) Py_XDECREF(keys[j]);
    Py_DECREF(seen);
    return result;
}

static PyMethodDef methods[] = {
    {"measure", measure, METH_VARARGS, "Measure finite candidate distances"},
    {"components", components, METH_VARARGS, "Group ordered ordinary edges"},
    {"copy_atoms", copy_atoms, METH_VARARGS, "Detach source atoms"},
    {"check_rows", check_rows, METH_VARARGS, "Validate source atom rows"},
    {NULL, NULL, 0, NULL}
};
static struct PyModuleDef module = {PyModuleDef_HEAD_INIT, "_finite_empirical_accel", NULL, -1, methods};
PyMODINIT_FUNC PyInit__finite_empirical_accel(void) { return PyModule_Create(&module); }
