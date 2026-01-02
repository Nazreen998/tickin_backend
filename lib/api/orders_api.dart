import '../api/http_client.dart';
import '../config/api_config.dart';

class OrdersApi {
  final HttpClient client;
  OrdersApi(this.client);

  String get _b => ApiConfig.orders;

  Future<Map<String, dynamic>> createOrder({
    required String distributorId,
    required String distributorName,
    required List<Map<String, dynamic>> items, // [{productId, qty}]
  }) {
    return client.post("$_b/create", body: {
      "distributorId": distributorId,
      "distributorName": distributorName,
      "items": items,
    });
  }

  Future<Map<String, dynamic>> confirmDraft(String orderId) {
    return client.post("$_b/confirm-draft/$orderId");
  }

  Future<Map<String, dynamic>> confirmOrder({
    required String orderId,
    required String companyCode, // required by backend
    Map<String, dynamic>? slot,  // optional: {date,time,vehicleType,pos}
  }) {
    return client.post("$_b/confirm/$orderId", body: {
      "companyCode": companyCode,
      if (slot != null) "slot": slot,
    });
  }

  Future<Map<String, dynamic>> updateItems({
    required String orderId,
    required List<Map<String, dynamic>> items,
  }) {
    return client.patch("$_b/update/$orderId", body: {"items": items});
  }

  Future<Map<String, dynamic>> cancelOrder(String orderId) {
    return client.delete("$_b/$orderId");
  }

  Future<Map<String, dynamic>> getOrderById(String orderId) {
    return client.get("$_b/$orderId");
  }

  Future<Map<String, dynamic>> pending() {
    return client.get("$_b/pending");
  }

  Future<Map<String, dynamic>> today() {
    return client.get("$_b/today");
  }

  Future<Map<String, dynamic>> delivery() {
    return client.get("$_b/delivery");
  }

  Future<Map<String, dynamic>> all({String? status}) {
    return client.get("$_b/all", query: status == null ? null : {"status": status});
  }

  Future<Map<String, dynamic>> my() {
    return client.get("$_b/my");
  }

  /// ✅ Your business: "Draft illa, pending then confirm"
  /// BUT your backend sometimes returns DRAFT (screenshot) and sometimes PENDING (service paste).
  /// So we handle both: if DRAFT => confirmDraft; else return created.
  Future<Map<String, dynamic>> placePendingThenConfirmDraftIfAny({
    required String distributorId,
    required String distributorName,
    required List<Map<String, dynamic>> items,
  }) async {
    final created = await createOrder(
      distributorId: distributorId,
      distributorName: distributorName,
      items: items,
    );

    final orderId = (created["orderId"] ?? "").toString();
    final status = (created["status"] ?? "").toString().toUpperCase();

    if (orderId.isEmpty) throw ApiException("orderId missing in create response");

    if (status == "DRAFT") {
      final confirmed = await confirmDraft(orderId);
      return {
        ...created,
        "message": confirmed["message"] ?? created["message"],
        "status": confirmed["status"] ?? "CONFIRMED",
      };
    }
    return created;
  }
}
