import '../api/http_client.dart';
import '../config/api_config.dart';

class SlotsApi {
  final HttpClient client;
  SlotsApi(this.client);

  Future<Map<String, dynamic>> getGrid({
    required String companyCode,
    required String date, // YYYY-MM-DD
  }) {
    return client.get(ApiConfig.slots, query: {
      "companyCode": companyCode,
      "date": date,
    });
  }

  Future<Map<String, dynamic>> book({
    required String companyCode,
    required String date,
    required String time,
    String? pos, // FULL only
    required String distributorCode,
    required double amount,
    required String orderId,
    String? userId,
  }) {
    return client.post("${ApiConfig.slots}/book", body: {
      "companyCode": companyCode,
      "date": date,
      "time": time,
      if (pos != null) "pos": pos,
      "distributorCode": distributorCode,
      "amount": amount,
      "orderId": orderId,
      if (userId != null) "userId": userId,
    });
  }

  // Manager
  Future<Map<String, dynamic>> managerCancelBooking(Map<String, dynamic> body) =>
      client.post("${ApiConfig.slots}/manager/cancel-booking", body: body);

  Future<Map<String, dynamic>> managerDisableSlot(Map<String, dynamic> body) =>
      client.post("${ApiConfig.slots}/disable-slot", body: body);

  Future<Map<String, dynamic>> managerOpenLast(Map<String, dynamic> body) =>
      client.post("${ApiConfig.slots}/open-last", body: body);

  Future<Map<String, dynamic>> managerConfirmMerge(Map<String, dynamic> body) =>
      client.post("${ApiConfig.slots}/merge/confirm", body: body);

  Future<Map<String, dynamic>> managerMoveMerge(Map<String, dynamic> body) =>
      client.post("${ApiConfig.slots}/merge/move", body: body);

  Future<Map<String, dynamic>> managerSetMax(Map<String, dynamic> body) =>
      client.post("${ApiConfig.slots}/set-max", body: body);

  Future<Map<String, dynamic>> managerEditTime(Map<String, dynamic> body) =>
      client.post("${ApiConfig.slots}/edit-time", body: body);
}
