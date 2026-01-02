// ignore_for_file: deprecated_member_use

import 'dart:convert';
import 'package:flutter/material.dart';
import '../main.dart';

class CreateOrderScreen extends StatefulWidget {
  const CreateOrderScreen({super.key});

  @override
  State<CreateOrderScreen> createState() => _CreateOrderScreenState();
}

class _CreateOrderScreenState extends State<CreateOrderScreen> {
  bool loading = false;

  // from /api/sales/home
  List<Map<String, dynamic>> distributors = [];
  List<Map<String, dynamic>> products = [];

  String? selectedDistributorId; // distributorCode
  String? selectedDistributorName; // agencyName

  bool goalsLoading = false;

  /// goalsByProductId[productId] = {remainingQty, usedQty, defaultGoal, ...}
  final Map<String, Map<String, dynamic>> goalsByProductId = {};

  final List<_OrderLine> lines = [_OrderLine()];

  // ---------- Helpers: Safe field getters ----------
  String _distId(Map d) =>
      (d["distributorId"] ?? d["distributorCode"] ?? d["code"] ?? d["sk"] ?? "")
          .toString();

  String _distName(Map d) =>
      (d["distributorName"] ?? d["agencyName"] ?? d["name"] ?? "").toString();

  String _prodId(Map p) =>
      (p["productId"] ?? p["Product Id"] ?? p["id"] ?? p["code"] ?? "")
          .toString();

  String _prodName(Map p) =>
      (p["name"] ?? p["Product Name"] ?? p["productName"] ?? "").toString();

  num _num(dynamic v) {
    if (v == null) return 0;
    if (v is num) return v;
    final s = v.toString().trim();
    return num.tryParse(s) ?? 0;
  }

  num _prodPrice(Map p) => _num(p["price"] ?? p["Price"] ?? p["unitPrice"]);

  // ---------- Totals ----------
  int get totalQty => lines.fold(0, (sum, l) => sum + (l.qty > 0 ? l.qty : 0));

  num get grandTotal => lines.fold<num>(
    0,
    (sum, l) => sum + (l.qty > 0 ? (l.qty * l.unitPrice) : 0),
  );

  int qtyForProduct(String productId) {
    int q = 0;
    for (final l in lines) {
      if (l.productId == productId && l.qty > 0) q += l.qty;
    }
    return q;
  }

  int? remainingForProduct(String productId) {
    final g = goalsByProductId[productId];
    if (g == null) return null;
    return int.tryParse("${g["remainingQty"] ?? g["remaining"] ?? ""}");
  }

  int? previewRemainingForProduct(String productId) {
    final rem = remainingForProduct(productId);
    if (rem == null) return null;
    return rem - qtyForProduct(productId);
  }

  bool goalExceededForProduct(String productId) {
    final prev = previewRemainingForProduct(productId);
    return prev != null && prev < 0;
  }

  // ---------- Lifecycle ----------
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (distributors.isEmpty && products.isEmpty) {
      _loadHome();
    }
  }

  void toast(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m)));
  }

  // ---------- API calls ----------
  Future<void> _loadHome() async {
    setState(() => loading = true);
    try {
      final res = await TickinAppScope.of(context).salesApi.home();

      // IMPORTANT:
      // Your /api/sales/home screenshot shows "distributors" not "distributorDropdown"
      final d =
          (res["distributors"] ?? res["distributorDropdown"] ?? []) as List;
      final p = (res["products"] ?? []) as List;

      setState(() {
        distributors = d
            .whereType<Map>()
            .map((e) => e.cast<String, dynamic>())
            .toList();
        products = p
            .whereType<Map>()
            .map((e) => e.cast<String, dynamic>())
            .toList();

        // If selected value no longer exists -> reset (prevents dropdown crash)
        if (selectedDistributorId != null &&
            !distributors.any((x) => _distId(x) == selectedDistributorId)) {
          selectedDistributorId = null;
          selectedDistributorName = null;
          goalsByProductId.clear();
        }

        for (final l in lines) {
          if (l.productId != null &&
              !products.any((x) => _prodId(x) == l.productId)) {
            l.productId = null;
            l.unitPrice = 0;
            l.qty = 0;
          }
        }
      });
    } catch (e) {
      toast(e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  Future<void> _fetchMonthlyGoals(String distributorCode) async {
    setState(() => goalsLoading = true);
    try {
      final res = await TickinAppScope.of(
        context,
      ).goalsApi.monthly(distributorCode: distributorCode);

      final goals = (res["goals"] ?? []) as List;

      final map = <String, Map<String, dynamic>>{};
      for (final g in goals.whereType<Map>()) {
        final m = g.cast<String, dynamic>();
        final pid = (m["productId"] ?? "").toString();
        if (pid.isEmpty) continue;
        map[pid] = m;
      }

      setState(() {
        goalsByProductId
          ..clear()
          ..addAll(map);
      });
    } catch (_) {
      setState(() => goalsByProductId.clear());
    } finally {
      if (mounted) setState(() => goalsLoading = false);
    }
  }

  Map<String, dynamic>? _findProduct(String productId) {
    for (final p in products) {
      if (_prodId(p) == productId) return p;
    }
    return null;
  }

  // ---------- Create Order ----------
  Future<void> _createOrder() async {
    if (selectedDistributorId == null) {
      toast("Select distributor");
      return;
    }
    if (selectedDistributorName == null ||
        selectedDistributorName!.trim().isEmpty) {
      // fallback (in case name missing)
      final picked = distributors.firstWhere(
        (x) => _distId(x) == selectedDistributorId,
        orElse: () => <String, dynamic>{},
      );
      selectedDistributorName = _distName(picked);
    }

    final items = <Map<String, dynamic>>[];
    for (final l in lines) {
      if (l.productId == null) continue;
      if (l.qty <= 0) continue;

      // goal check per product
      if (goalExceededForProduct(l.productId!)) {
        toast("Goal exceeded for product ${l.productId}");
        return;
      }

      items.add({"productId": l.productId, "qty": l.qty});
    }

    if (items.isEmpty) {
      toast("Add at least one product + qty");
      return;
    }

    setState(() => loading = true);
    try {
      final scope = TickinAppScope.of(context);

      // 1) create (and if DRAFT -> confirmDraft handled in your API helper)
      final created = await scope.ordersApi.placePendingThenConfirmDraftIfAny(
        distributorId: selectedDistributorId!,
        distributorName: selectedDistributorName ?? selectedDistributorId!,
        items: items,
      );

      final orderId = (created["orderId"] ?? "").toString();
      final status = (created["status"] ?? "").toString();

      // 2) Optional: try to confirm (straight confirm) if companyCode available
      //    (If backend doesn't allow, ignore without crashing)
      try {
        final userJson = await scope.tokenStore.getUserJson();
        String? companyCode;
        if (userJson != null && userJson.isNotEmpty) {
          final u = jsonDecode(userJson) as Map<String, dynamic>;
          final companyId = (u["companyId"] ?? "")
              .toString(); // e.g. COMPANY#VAGR_IT
          if (companyId.contains("#")) companyCode = companyId.split("#").last;
          companyCode ??= (u["companyCode"] ?? "").toString();
        }
        if (companyCode != null &&
            companyCode.isNotEmpty &&
            orderId.isNotEmpty) {
          await scope.ordersApi.confirmOrder(
            orderId: orderId,
            companyCode: companyCode,
          );
        }
      } catch (_) {
        // ignore
      }

      toast("✅ Order: $orderId | $status");

      // refresh goals (backend deduct)
      await _fetchMonthlyGoals(selectedDistributorId!);

      // clear lines only
      setState(() {
        lines
          ..clear()
          ..add(_OrderLine());
      });
    } catch (e) {
      toast(e.toString());
    } finally {
      if (mounted) setState(() => loading = false);
    }
  }

  // ---------- UI helpers ----------
  void _addLine() => setState(() => lines.add(_OrderLine()));
  void _removeLine(int idx) => setState(() => lines.removeAt(idx));

  Widget _ellipsisText(String s) =>
      Text(s, maxLines: 1, overflow: TextOverflow.ellipsis);

  Widget _goalPreviewCard() {
    if (selectedDistributorId == null) return const SizedBox.shrink();

    if (goalsLoading) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: 10),
        child: LinearProgressIndicator(),
      );
    }

    // show only for selected products in lines
    final selectedPids = lines
        .map((l) => l.productId)
        .whereType<String>()
        .toSet()
        .toList();
    if (selectedPids.isEmpty) return const SizedBox.shrink();

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              "Goal Preview (Product-wise)",
              style: TextStyle(fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            ...selectedPids.map((pid) {
              final rem = remainingForProduct(pid);
              final entered = qtyForProduct(pid);
              final prev = previewRemainingForProduct(pid);
              final exceeded = goalExceededForProduct(pid);

              final prod = _findProduct(pid);
              final name = prod == null ? "" : _prodName(prod);

              return Padding(
                padding: const EdgeInsets.only(bottom: 8),
                child: Row(
                  children: [
                    Expanded(
                      child: _ellipsisText(
                        "$pid ${name.isEmpty ? "" : "- $name"}",
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      "Rem: ${rem ?? "-"} | Qty: $entered | Prev: ${prev ?? "-"}",
                      style: TextStyle(
                        fontWeight: FontWeight.w600,
                        color: exceeded ? Colors.red : Colors.green,
                      ),
                    ),
                  ],
                ),
              );
            }),
          ],
        ),
      ),
    );
  }

  // ---------- Build ----------
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text("Create Order"),
        actions: [
          IconButton(onPressed: _loadHome, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(16),
              children: [
                // Distributor
                DropdownButtonFormField<String>(
                  isExpanded: true,
                  value:
                      (selectedDistributorId != null &&
                          distributors.any(
                            (d) => _distId(d) == selectedDistributorId,
                          ))
                      ? selectedDistributorId
                      : null,
                  decoration: const InputDecoration(
                    labelText: "Distributor",
                    border: OutlineInputBorder(),
                  ),
                  items: distributors.map((d) {
                    final id = _distId(d);
                    final name = _distName(d);
                    final label = name.isEmpty ? id : "$id - $name";
                    return DropdownMenuItem<String>(
                      value: id,
                      child: _ellipsisText(label),
                    );
                  }).toList(),
                  onChanged: (val) async {
                    if (val == null) return;

                    final picked = distributors.firstWhere(
                      (x) => _distId(x) == val,
                      orElse: () => <String, dynamic>{},
                    );

                    setState(() {
                      selectedDistributorId = val;
                      selectedDistributorName = _distName(picked);
                      goalsByProductId.clear();
                    });

                    await _fetchMonthlyGoals(val);
                  },
                ),

                const SizedBox(height: 12),
                _goalPreviewCard(),
                const SizedBox(height: 12),

                const Text(
                  "Items",
                  style: TextStyle(fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 8),

                ...List.generate(lines.length, (i) {
                  final l = lines[i];

                  final lineTotal = (l.qty > 0) ? (l.qty * l.unitPrice) : 0;
                  final exceeded = (l.productId != null)
                      ? goalExceededForProduct(l.productId!)
                      : false;

                  return Card(
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          DropdownButtonFormField<String>(
                            isExpanded: true,
                            value:
                                (l.productId != null &&
                                    products.any(
                                      (p) => _prodId(p) == l.productId,
                                    ))
                                ? l.productId
                                : null,
                            decoration: const InputDecoration(
                              labelText: "Product",
                              border: OutlineInputBorder(),
                            ),
                            items: products.map((p) {
                              final pid = _prodId(p);
                              final name = _prodName(p);
                              final label = name.isEmpty ? pid : "$pid - $name";
                              return DropdownMenuItem(
                                value: pid,
                                child: _ellipsisText(label),
                              );
                            }).toList(),
                            onChanged: (val) {
                              if (val == null) return;
                              final prod = _findProduct(val);

                              setState(() {
                                l.productId = val;
                                l.unitPrice = prod == null
                                    ? 0
                                    : _prodPrice(prod);
                              });
                            },
                          ),

                          const SizedBox(height: 10),

                          Row(
                            children: [
                              Flexible(
                                fit: FlexFit.loose,
                                child: TextFormField(
                                  initialValue: l.qty == 0
                                      ? ""
                                      : l.qty.toString(),
                                  keyboardType: TextInputType.number,
                                  decoration: InputDecoration(
                                    labelText: "Qty",
                                    border: const OutlineInputBorder(),
                                    errorText: exceeded
                                        ? "Goal exceeded"
                                        : null,
                                  ),
                                  onChanged: (v) {
                                    final n = int.tryParse(v.trim()) ?? 0;
                                    setState(() => l.qty = n);
                                  },
                                ),
                              ),
                              const SizedBox(width: 10),
                              Flexible(
                                fit: FlexFit.loose,
                                child: InputDecorator(
                                  decoration: const InputDecoration(
                                    labelText: "Unit Price",
                                    border: OutlineInputBorder(),
                                  ),
                                  child: Text(
                                    l.unitPrice > 0
                                        ? "₹${l.unitPrice.toStringAsFixed(2)}"
                                        : "-",
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ),
                              ),
                            ],
                          ),

                          const SizedBox(height: 8),
                          Text(
                            "Line Total: ₹${lineTotal.toStringAsFixed(2)}",
                            style: const TextStyle(fontWeight: FontWeight.w600),
                          ),

                          const SizedBox(height: 8),
                          Row(
                            children: [
                              TextButton.icon(
                                onPressed: _addLine,
                                icon: const Icon(Icons.add),
                                label: const Text("Add"),
                              ),
                              const Spacer(),
                              if (lines.length > 1)
                                TextButton.icon(
                                  onPressed: () => _removeLine(i),
                                  icon: const Icon(Icons.delete),
                                  label: const Text("Remove"),
                                ),
                            ],
                          ),
                        ],
                      ),
                    ),
                  );
                }),

                const SizedBox(height: 8),

                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          "Total Qty: $totalQty",
                          style: const TextStyle(fontWeight: FontWeight.w600),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          "Grand Total: ₹${grandTotal.toStringAsFixed(2)}",
                          style: const TextStyle(fontWeight: FontWeight.w700),
                        ),
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 12),
                ElevatedButton(
                  onPressed: _createOrder,
                  child: const Text("Create Order"),
                ),
              ],
            ),
    );
  }
}

class _OrderLine {
  String? productId;
  int qty = 0;
  num unitPrice = 0;
}
