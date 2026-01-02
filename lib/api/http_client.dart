import 'dart:convert';
import 'package:http/http.dart' as http;
import '../config/api_config.dart';
import '../storage/token_store.dart';

class ApiException implements Exception {
  final int? statusCode;
  final String message;
  ApiException(this.message, {this.statusCode});
  @override
  String toString() => message;
}

class HttpClient {
  final TokenStore tokenStore;
  HttpClient(this.tokenStore);

  Uri _uri(String path, [Map<String, String>? query]) {
    return Uri.parse("${ApiConfig.baseUrl}$path").replace(queryParameters: query);
  }

  Future<Map<String, String>> _headers({bool auth = true}) async {
    final h = <String, String>{'Content-Type': 'application/json'};
    if (auth) {
      final token = await tokenStore.getToken();
      if (token == null || token.isEmpty) {
        throw ApiException("Token missing. Please login again.");
      }
      h['Authorization'] = 'Bearer $token';
    }
    return h;
  }

  Map<String, dynamic> _decodeBody(http.Response res) {
    if (res.body.isEmpty) return {};
    final decoded = jsonDecode(res.body);
    if (decoded is Map<String, dynamic>) return decoded;
    return {"data": decoded};
  }

  Future<Map<String, dynamic>> get(String path,
      {Map<String, String>? query, bool auth = true}) async {
    final res = await http.get(_uri(path, query), headers: await _headers(auth: auth));
    final body = _decodeBody(res);
    if (res.statusCode != 200) {
      throw ApiException(body["message"]?.toString() ?? "GET failed (${res.statusCode})",
          statusCode: res.statusCode);
    }
    return body;
  }

  Future<Map<String, dynamic>> post(String path,
      {Object? body, bool auth = true}) async {
    final res = await http.post(
      _uri(path),
      headers: await _headers(auth: auth),
      body: body == null ? null : jsonEncode(body),
    );
    final decoded = _decodeBody(res);
    if (res.statusCode != 200 && res.statusCode != 201) {
      throw ApiException(decoded["message"]?.toString() ?? "POST failed (${res.statusCode})",
          statusCode: res.statusCode);
    }
    return decoded;
  }

  Future<Map<String, dynamic>> patch(String path, {Object? body}) async {
    final res = await http.patch(
      _uri(path),
      headers: await _headers(auth: true),
      body: body == null ? null : jsonEncode(body),
    );
    final decoded = _decodeBody(res);
    if (res.statusCode != 200) {
      throw ApiException(decoded["message"]?.toString() ?? "PATCH failed (${res.statusCode})",
          statusCode: res.statusCode);
    }
    return decoded;
  }

  Future<Map<String, dynamic>> delete(String path) async {
    final res = await http.delete(_uri(path), headers: await _headers(auth: true));
    final decoded = _decodeBody(res);
    if (res.statusCode != 200) {
      throw ApiException(decoded["message"]?.toString() ?? "DELETE failed (${res.statusCode})",
          statusCode: res.statusCode);
    }
    return decoded;
  }
}
